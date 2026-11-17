//! Posting a video through the social's own upload page, in a visible app window, while its API
//! is not approved yet (TikTok Sandbox, YouTube audit) or not used (X).
//!
//! Each brand gets its own browser profile (cookie folder) for posting, so every brand stays signed in
//! to its own TikTok, YouTube and X account. TikTok and YouTube windows can fill upload details;
//! X is a manual handoff with no page automation. Nate reviews and posts on each site himself.

use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::Platform;

static NEXT: AtomicU64 = AtomicU64::new(1);
/// Videos bigger than this are attached by hand: the page gets the file in pieces through script calls.
const MAX_ATTACH_BYTES: u64 = 512 * 1024 * 1024;
const CHUNK_BYTES: usize = 1024 * 1024;
const MAX_TEXT_CHARS: usize = 5_000;
/// Marks a page that showed its post went up (set by the post script with `history.replaceState`).
const POSTED_MARK: &str = "socialspace-posted";
pub const EVENT: &str = "posting-window";

/// What goes into the upload page. Sent by the app for one video and one social.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostRequest {
    platform: Platform,
    brand_id: String,
    video_id: String,
    /// The brand's profile on this social: its saved password fills the sign-in page.
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    handle: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    video_path: String,
    #[serde(default)]
    title: String,
    /// The description followed by the hashtags.
    #[serde(default)]
    text: String,
    #[serde(default)]
    made_with_ai: bool,
    #[serde(default)]
    made_for_kids: bool,
    /// "0:03.2", or empty for the first frame.
    #[serde(default)]
    cover: String,
    /// The cover moment in ms; None keeps the social's own pick.
    #[serde(default)]
    cover_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PostConfig<'a> {
    platform: Platform,
    handle: &'a str,
    title: &'a str,
    text: &'a str,
    made_with_ai: bool,
    made_for_kids: bool,
    cover: &'a str,
    cover_ms: Option<u64>,
    upload_url: &'a str,
    file_name: String,
    /// Why the video is not attached by the app, if it isn't.
    file_note: Option<String>,
    /// Whether sign-in pages get the profile's saved login (its own, or the parent login of an
    /// Instagram profile or YouTube channel).
    login_filled: bool,
}

/// What the app hears about a posting window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PostingUpdate {
    video_id: String,
    platform: Platform,
    /// "posted": the page showed the post went up. "closed": the window was closed.
    state: &'static str,
    posted: bool,
}

pub(crate) fn upload_url(platform: Platform) -> Option<&'static str> {
    match platform {
        Platform::Tiktok => Some("https://www.tiktok.com/tiktokstudio/upload"),
        Platform::Youtube => Some("https://www.youtube.com/upload"),
        Platform::X => Some("https://x.com/compose/post"),
        // Instagram posts through its API.
        Platform::Instagram | Platform::Facebook => None,
    }
}

/// Sign-in pages, where the account's username and password are filled in.
pub(crate) fn is_sign_in(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("").trim_start_matches("www.");
    let path = url.path();
    match host {
        "accounts.google.com" => true,
        "tiktok.com" => path.starts_with("/login"),
        "x.com" | "twitter.com" => path.starts_with("/i/flow/login") || path == "/login",
        "instagram.com" => path.starts_with("/accounts/login"),
        _ => false,
    }
}

/// The pages a posting window may fill: the social's own sites and Google's sign-in.
fn on_social(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            ["tiktok.com", "youtube.com", "x.com", "twitter.com", "instagram.com", "accounts.google.com"]
                .iter()
                .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
        })
}

/// X's automation rules prohibit scripting its website, so its windows are manual.
fn may_automate(platform: Platform) -> bool {
    platform != Platform::X
}

/// Even a window opened for another provider can navigate to X; never run form scripts there.
fn may_fill_page(url: &url::Url) -> bool {
    on_social(url) && !crate::browser::is_x_site(url)
}

/// Whether the page shows the post went up: the post script marked it, or TikTok Studio moved on
/// from the upload page to the list of posts after Post was pressed.
pub(crate) fn shows_posted(platform: Platform, url: &url::Url, was_uploading: bool) -> bool {
    if url.fragment() == Some(POSTED_MARK) {
        return true;
    }
    platform == Platform::Tiktok && was_uploading && url.path().starts_with("/tiktokstudio/content")
}

fn is_upload_page(platform: Platform, url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    match platform {
        Platform::Tiktok => host.ends_with("tiktok.com") && url.path().starts_with("/tiktokstudio/upload"),
        Platform::Youtube => host == "studio.youtube.com" || (host.ends_with("youtube.com") && url.path().starts_with("/upload")),
        Platform::X => (host == "x.com" || host == "twitter.com") && !is_sign_in(url),
        Platform::Instagram | Platform::Facebook => false,
    }
}

/// One cookie folder per brand, so each brand stays signed in to its own accounts.
fn profile_dir(app: &AppHandle, brand_id: &str) -> Result<PathBuf, String> {
    let safe: String = brand_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    if safe.is_empty() {
        return Err("Choose the brand to post as.".into());
    }
    let base = app.path().app_local_data_dir().map_err(|_| "Could not find the app's data folder.")?;
    Ok(base.join("posting").join(safe))
}

fn check(request: &PostRequest) -> Result<(), String> {
    if request.text.chars().count() > MAX_TEXT_CHARS || request.title.chars().count() > 200 || request.cover.len() > 20 {
        return Err("The post text is too long.".into());
    }
    if request.handle.len() > 200 || request.email.len() > 320 || request.video_id.len() > 100 {
        return Err("The account details are not valid.".into());
    }
    Ok(())
}

/// The video to attach, or why it is attached by hand.
fn attachable(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("This video has no file on this PC yet.".into());
    }
    let file = crate::video_files::video_file(path)?;
    let size = std::fs::metadata(&file).map_err(|_| "The video file can't be read.".to_string())?.len();
    if size > MAX_ATTACH_BYTES {
        return Err("The video is over 512 MB, so pick it on the page yourself.".into());
    }
    Ok(file)
}

fn mime_of(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()).as_deref() {
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("m4v") => "video/x-m4v",
        _ => "video/mp4",
    }
}

/// Hands the video to the page in pieces, then tells the post script it is ready to attach.
async fn send_file(window: tauri::Webview, path: PathBuf) {
    let read_path = path.clone();
    let read = tauri::async_runtime::spawn_blocking(move || std::fs::read(read_path)).await;
    let Ok(Ok(bytes)) = read else {
        let _ = window.eval("window.__socialspacePost && window.__socialspacePost.fileFailed('The video file could not be read.')");
        return;
    };
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "video.mp4".into());
    if window.eval("window.__socialspaceParts = [];").is_err() {
        return;
    }
    for chunk in bytes.chunks(CHUNK_BYTES) {
        let script = format!("window.__socialspaceParts && window.__socialspaceParts.push('{}');", STANDARD.encode(chunk));
        if window.eval(&script).is_err() {
            return;
        }
    }
    let done = format!(
        "window.__socialspacePost && window.__socialspacePost.fileReady({}, {});",
        serde_json::to_string(&name).unwrap_or_else(|_| "\"video.mp4\"".into()),
        serde_json::to_string(mime_of(&path)).unwrap_or_else(|_| "\"video/mp4\"".into()),
    );
    let _ = window.eval(&done);
}

struct Posting {
    request: PostRequest,
    /// None for a profile window, which only signs in and shows the page.
    config_script: Option<String>,
    sign_in_script: Option<String>,
    /// A profile-edit window: fills the brand's picture, name, bio and keywords (never on a sign-in page).
    profile_script: Option<String>,
    file: Option<PathBuf>,
    /// Set once the other PC's sign-in was put into this window's folder.
    shared_session: std::sync::atomic::AtomicBool,
}

fn page_loaded(posting: &Posting, webview: &tauri::Webview) {
    if !may_automate(posting.request.platform) { return; }
    if crate::browser::to_email_login(webview) {
        return;
    }
    let Ok(url) = webview.url() else { return };
    if !may_fill_page(&url) {
        return;
    }
    if is_sign_in(&url) {
        if let Some(script) = &posting.sign_in_script {
            let _ = webview.eval(script);
        }
        // The social did not take the session shared from the other PC: say so; the login is filled in.
        if posting.shared_session.load(Ordering::Relaxed) {
            let _ = webview.eval(crate::browser_sessions::REJECTED_NOTICE);
        }
    }
    if let Some(script) = &posting.config_script {
        let _ = webview.eval(script);
    }
    if let (Some(script), false) = (&posting.profile_script, is_sign_in(&url)) {
        let _ = webview.eval(script);
    }
    if let (Some(path), true) = (&posting.file, is_upload_page(posting.request.platform, &url)) {
        tauri::async_runtime::spawn(send_file(webview.clone(), path.clone()));
    }
}

fn build_window(
    app: &AppHandle,
    url: url::Url,
    dir: PathBuf,
    posting: std::sync::Arc<Posting>,
    features: Option<NewWindowFeatures>,
) -> Result<WebviewWindow, String> {
    let label = format!("post-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let popup_app = app.clone();
    let popup_dir = dir.clone();
    let popup_posting = posting.clone();
    let loaded = posting.clone();
    let name = match posting.request.platform {
        Platform::Tiktok => "TikTok",
        Platform::Youtube => "YouTube",
        Platform::X => "X",
        Platform::Instagram => "Instagram",
        Platform::Facebook => "Facebook",
    };
    let handle = &posting.request.handle;
    let verb = window_verb(&posting.request.video_id);
    let title = if handle.is_empty() { format!("Socialspace · {verb} {name}") } else { format!("Socialspace · {verb} {name} as @{handle}") };
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1200.0, 860.0)
        .data_directory(dir)
        // WebView2's own form autofill would offer whatever was typed in this brand window before (the
        // main Gmail, another profile's login) and fill it over the app's fill; the app fills logins itself.
        .general_autofill_enabled(false);
    let builder = if may_automate(posting.request.platform) {
        builder.initialization_script(crate::browser::EMAIL_LOGIN_SCRIPT)
    } else { builder };
    let builder = builder
        .on_navigation(|url| crate::browser::allowed_navigation(url, false))
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                page_loaded(&loaded, window.as_ref());
            }
        })
        .on_new_window(move |url, features| {
            if !crate::browser::allowed_navigation(&url, false) {
                return NewWindowResponse::Deny;
            }
            // Sign-in pop-ups share the brand's cookie folder, or WebView2 can't open them.
            let blank = "about:blank".parse().expect("valid blank URL");
            match build_window(&popup_app, blank, popup_dir.clone(), popup_posting.clone(), Some(features)) {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        });
    let builder = if let Some(features) = features { builder.window_features(features) } else { builder };
    builder.build().map_err(|_| "Could not open the upload page inside the app.".into())
}

fn window_verb(video_id: &str) -> &'static str {
    if video_id.is_empty() { "Profile on" } else { "Post on" }
}

/// Watches the window for the post going up, and tells the app when it does or when the window closes.
fn watch(app: AppHandle, window: WebviewWindow, request: PostRequest) {
    let platform = request.platform;
    let video_id = request.video_id.clone();
    let closed_app = app.clone();
    let closed_video = video_id.clone();
    let posted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let posted_on_close = posted.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let update = PostingUpdate { video_id: closed_video.clone(), platform, state: "closed", posted: posted_on_close.load(Ordering::Relaxed) };
            let _ = closed_app.emit(EVENT, update);
        }
    });
    if !may_automate(platform) { return; }
    tauri::async_runtime::spawn(async move {
        let mut was_uploading = false;
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let Ok(url) = window.url() else { return };
            was_uploading = was_uploading || is_upload_page(platform, &url);
            if shows_posted(platform, &url, was_uploading) {
                posted.store(true, Ordering::Relaxed);
                let _ = app.emit(EVENT, PostingUpdate { video_id, platform, state: "posted", posted: true });
                return;
            }
        }
    });
}

/// Opens a brand's upload page for review. X is entirely manual; other supported pages attempt to fill details.
#[tauri::command]
pub async fn open_posting_window(app: AppHandle, request: PostRequest) -> Result<String, String> {
    check(&request)?;
    let address = upload_url(request.platform).ok_or("Instagram posts through its API, not a page.")?;
    let dir = profile_dir(&app, &request.brand_id)?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not make the brand's browser folder.")?;
    if !may_automate(request.platform) {
        let posting = std::sync::Arc::new(Posting { request: request.clone(), config_script: None, sign_in_script: None, profile_script: None, file: None, shared_session: Default::default() });
        let url: url::Url = address.parse().map_err(|_| "Invalid upload address.")?;
        let window = open_signed_in(&app, url, dir, posting)?;
        let label = window.label().to_owned();
        watch(app, window, request);
        return Ok(label);
    }
    let (file, file_note) = match attachable(&request.video_path) {
        Ok(file) => (Some(file), None),
        Err(note) => (None, Some(note)),
    };
    let file_name = file
        .as_ref()
        .and_then(|file| file.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let config = PostConfig {
        platform: request.platform,
        handle: &request.handle,
        title: &request.title,
        text: &request.text,
        made_with_ai: request.made_with_ai,
        made_for_kids: request.made_for_kids,
        cover: &request.cover,
        cover_ms: request.cover_ms,
        upload_url: address,
        file_name,
        file_note,
        login_filled: request.account_id.as_deref().is_some_and(|id| !id.is_empty()),
    };
    let data = serde_json::to_string(&config).map_err(|_| "Could not prepare the post.")?;
    let config_script = format!("({POST_SCRIPT})({data});");
    let password = match request.account_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => crate::account_passwords::read(id).ok().flatten(),
        None => None,
    };
    let sign_in_script = brand_sign_in(&request.account_id, request.platform, &request.handle, &request.email, password)?;
    let posting = std::sync::Arc::new(Posting { request: request.clone(), config_script: Some(config_script), sign_in_script, profile_script: None, file, shared_session: Default::default() });
    let url: url::Url = address.parse().map_err(|_| "Invalid upload address.")?;
    let window = open_signed_in(&app, url, dir, posting)?;
    let label = window.label().to_owned();
    watch(app, window, request);
    Ok(label)
}

/// How often an open brand window's sign-in is saved for the other PC.
const SESSION_SAVE_EVERY: Duration = Duration::from_secs(20);
/// When a new brand window's sign-in is first checked, once its page had time to load.
const SIGN_IN_FIRST_CHECK: Duration = Duration::from_secs(4);
/// Refresh the visible status promptly after someone finishes signing in.
const SIGN_IN_CHECK_EVERY: Duration = Duration::from_secs(5);

/// Opens a brand window: first on a blank page, so the other PC's newer sign-in (if any) is put into
/// the brand's folder before the social loads, then on `url`. While the window is open its sign-in is
/// saved now and then, so the other PC gets it too.
fn open_signed_in(app: &AppHandle, url: url::Url, dir: PathBuf, posting: std::sync::Arc<Posting>) -> Result<WebviewWindow, String> {
    let blank: url::Url = "about:blank".parse().expect("valid blank URL");
    let brand = posting.request.brand_id.clone();
    let platform = posting.request.platform;
    let window = build_window(app, blank, dir, posting.clone(), None)?;
    let (task_app, task_window) = (app.clone(), window.clone());
    tauri::async_runtime::spawn(async move {
        // WebView2 cookies must be handled off the main thread.
        let shared = if may_automate(platform) {
            let (restore_app, restore_window, restore_brand) = (task_app.clone(), task_window.clone(), brand.clone());
            tauri::async_runtime::spawn_blocking(move || {
                // A social this PC's folder is already signed in to keeps its own sign-in.
                let here: Vec<Platform> = [Platform::Tiktok, Platform::Youtube, Platform::X, Platform::Instagram].into_iter()
                    .filter(|social| crate::sign_in_state::known_signed_in(&restore_app, &restore_brand, *social)).collect();
                crate::browser_sessions::restore(&restore_app, &restore_window, &restore_brand, &here)
            }).await.unwrap_or(false)
        } else { false };
        posting.shared_session.store(shared, Ordering::Relaxed);
        if task_window.navigate(url).is_err() {
            return;
        }
        // The brand card shows whether this folder is signed in, and as whom: checked soon after the
        // page loads, then with every save.
        let check = |app: AppHandle, window: WebviewWindow, brand: String| async move {
            let _ = tauri::async_runtime::spawn_blocking(move || crate::sign_in_state::check(&app, &window, &brand, platform)).await;
        };
        tokio::time::sleep(SIGN_IN_FIRST_CHECK).await;
        if task_window.url().is_err() {
            return;
        }
        check(task_app.clone(), task_window.clone(), brand.clone()).await;
        let mut last_save = tokio::time::Instant::now();
        loop {
            tokio::time::sleep(SIGN_IN_CHECK_EVERY).await;
            if task_window.url().is_err() {
                return;
            }
            check(task_app.clone(), task_window.clone(), brand.clone()).await;
            if !may_automate(platform) || last_save.elapsed() < SESSION_SAVE_EVERY { continue; }
            last_save = tokio::time::Instant::now();
            // Only a signed-in window is shared with the other PC.
            let (save_app, save_window, save_brand) = (task_app.clone(), task_window.clone(), brand.clone());
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let signed_in = crate::sign_in_state::known_signed_in(&save_app, &save_brand, platform);
                crate::browser_sessions::capture(&save_app, &save_window, &save_brand, signed_in)
            }).await;
        }
    });
    Ok(window)
}

/// The sign-in fill for a brand profile's window. Only a profile the app sends is filled: its own
/// login on TikTok, or the parent login an Instagram profile or YouTube channel lives under.
/// Without one the sign-in page is left for Nate.
fn brand_sign_in(account_id: &Option<String>, platform: Platform, handle: &str, email: &str, password: Option<String>) -> Result<Option<String>, String> {
    if !may_automate(platform) { return Ok(None); }
    if account_id.as_deref().map_or(true, str::is_empty) {
        return Ok(None);
    }
    // TikTok signs in with the profile's username so a shared email cannot select another account.
    match platform {
        Platform::Youtube | Platform::Instagram if !email.is_empty() => crate::autofill::sign_in_script(email, email, password),
        _ => crate::autofill::sign_in_script(handle.trim().trim_start_matches('@'), "", password),
    }
}

/// A profile's public page, where its live videos are.
pub(crate) fn profile_url(platform: Platform, handle: &str) -> Option<String> {
    let handle = handle.trim().trim_start_matches('@');
    let valid = !handle.is_empty() && handle.len() <= 100 && handle.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !valid {
        return None;
    }
    Some(match platform {
        Platform::Tiktok => format!("https://www.tiktok.com/@{handle}"),
        Platform::Youtube => format!("https://www.youtube.com/@{handle}/videos"),
        Platform::X => format!("https://x.com/{handle}"),
        Platform::Instagram => format!("https://www.instagram.com/{handle}/"),
        // A Page's username or its numeric ID.
        Platform::Facebook => format!("https://www.facebook.com/{handle}"),
    })
}

/// What a profile window needs: the brand (for its sign-in folder) and the profile.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileRequest {
    platform: Platform,
    brand_id: String,
    #[serde(default)]
    account_id: Option<String>,
    handle: String,
    #[serde(default)]
    email: String,
    /// true: the default browser on this PC. false: a Social Space window signed in as the brand.
    #[serde(default)]
    in_browser: bool,
    /// Which of the profile's pages to open: its public page (default) or its account settings.
    #[serde(default)]
    target: ProfileTarget,
}

/// A page of the brand's own profile that a window can open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfileTarget {
    #[default]
    Profile,
    /// The account's settings, e.g. Instagram's "Account type and tools" to switch to a professional account.
    Settings,
}

/// The settings page of a profile, signed in as the brand. Only Instagram needs one today.
pub(crate) fn settings_url(platform: Platform) -> Option<&'static str> {
    match platform {
        Platform::Instagram => Some("https://www.instagram.com/accounts/edit/"),
        _ => None,
    }
}

/// Opens a brand profile's public page, to see the videos that are live: in a Social Space window
/// that shares the brand's posting sign-in, or in the default browser.
#[tauri::command]
pub async fn open_profile_page(app: AppHandle, request: ProfileRequest) -> Result<(), String> {
    let address = match request.target {
        ProfileTarget::Profile => profile_url(request.platform, &request.handle).ok_or("This profile has no valid username yet. Add it under Edit details.")?,
        ProfileTarget::Settings => settings_url(request.platform).ok_or("This social has no settings page to open here.")?.to_owned(),
    };
    if request.email.len() > 320 {
        return Err("The account details are not valid.".into());
    }
    if request.in_browser {
        return std::process::Command::new("explorer.exe")
            .arg(&address)
            .spawn()
            .map(|_| ())
            .map_err(|_| "Could not open your browser.".to_string());
    }
    let dir = profile_dir(&app, &request.brand_id)?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not make the brand's browser folder.")?;
    let password = if may_automate(request.platform) {
        request.account_id.as_deref().filter(|id| !id.is_empty()).and_then(|id| crate::account_passwords::read(id).ok().flatten())
    } else { None };
    let sign_in_script = brand_sign_in(&request.account_id, request.platform, &request.handle, &request.email, password)?;
    let post = PostRequest {
        platform: request.platform,
        brand_id: request.brand_id.clone(),
        video_id: String::new(),
        account_id: request.account_id.clone(),
        handle: request.handle.trim().trim_start_matches('@').to_owned(),
        email: request.email.clone(),
        video_path: String::new(),
        title: String::new(),
        text: String::new(),
        made_with_ai: false,
        made_for_kids: false,
        cover: String::new(),
        cover_ms: None,
    };
    let posting = std::sync::Arc::new(Posting { request: post, config_script: None, sign_in_script, profile_script: None, file: None, shared_session: Default::default() });
    let address = signed_out_entry(request.platform, &address, crate::sign_in_state::known_signed_in(&app, &request.brand_id, request.platform));
    let url: url::Url = address.parse().map_err(|_| "Invalid profile address.")?;
    open_signed_in(&app, url, dir, posting).map(|_| ())
}

/// Each social's "forgot password" page. YouTube channels sign in through the main Google account, which
/// the app never resets.
pub(crate) fn reset_url(platform: Platform) -> Option<&'static str> {
    match platform {
        Platform::Tiktok => Some("https://www.tiktok.com/login/email/forget-password"),
        Platform::X => Some("https://x.com/i/flow/password_reset"),
        Platform::Instagram => Some("https://www.instagram.com/accounts/password/reset/"),
        // YouTube and Facebook Pages sit under your own Google or Facebook login, which the app never resets.
        Platform::Youtube | Platform::Facebook => None,
    }
}

/// New passwords handed to a reset window and not saved yet, per profile. Memory only: the saved
/// password changes only when Nate says the reset went through.
static PENDING_RESETS: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> = std::sync::Mutex::new(None);

/// Opens the social's password reset page in the brand's window with the profile's email and a new
/// strong password filled in. Nate enters the emailed code and presses the button; the new password is
/// saved by `save_reset_password` once he confirms it worked.
#[tauri::command]
pub async fn open_password_reset(app: AppHandle, request: ProfileRequest) -> Result<(), String> {
    if !may_automate(request.platform) {
        return Err("Reset your password on X, then save the new password in Socialspace.".into());
    }
    let address = reset_url(request.platform).ok_or("YouTube signs in with your main Google account, so there is nothing to reset here.")?;
    let account_id = request.account_id.clone().filter(|id| !id.is_empty()).ok_or("Choose the profile to reset.")?;
    if request.email.len() > 320 || account_id.len() > 128 {
        return Err("The account details are not valid.".into());
    }
    let password = crate::account_passwords::generate_password()?;
    let login = if request.email.trim().is_empty() { request.handle.trim().trim_start_matches('@').to_owned() } else { request.email.trim().to_owned() };
    let script = crate::autofill::reset_script(&login, &password)?;
    if let Ok(mut pending) = PENDING_RESETS.lock() {
        pending.get_or_insert_with(std::collections::HashMap::new).insert(account_id.clone(), password);
    }
    let dir = profile_dir(&app, &request.brand_id)?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not make the brand's browser folder.")?;
    let post = PostRequest {
        platform: request.platform,
        brand_id: request.brand_id.clone(),
        video_id: String::new(),
        account_id: Some(account_id),
        handle: request.handle.trim().trim_start_matches('@').to_owned(),
        email: request.email.clone(),
        video_path: String::new(),
        title: String::new(),
        text: String::new(),
        made_with_ai: false,
        made_for_kids: false,
        cover: String::new(),
        cover_ms: None,
    };
    // The same fill runs on the reset page and on the sign-in page the social may return to afterwards,
    // where the new password is then already filled.
    let posting = std::sync::Arc::new(Posting { request: post, config_script: None, sign_in_script: Some(script.clone()), profile_script: Some(script), file: None, shared_session: Default::default() });
    let url: url::Url = address.parse().map_err(|_| "Invalid reset address.")?;
    open_signed_in(&app, url, dir, posting).map(|_| ())
}

/// Saves the new password of a reset Nate finished, replacing the old saved one.
#[tauri::command]
pub fn save_reset_password(account_id: String) -> Result<(), String> {
    let password = PENDING_RESETS.lock().ok().and_then(|mut pending| pending.as_mut()?.remove(&account_id))
        .ok_or("Press Reset password first, then save once the social accepted the new password.")?;
    crate::account_passwords::set_account_password(account_id, password)
}

/// Runs in the upload page. Shows a panel with the post (and Copy buttons as a fallback), attaches the
/// video once the app has handed it over, fills the caption and title once each, sets the cover, the
/// AI label and YouTube's audience, steps YouTube through to Visibility and picks Public, and watches
/// for the page saying the post went up. The one button it never presses is Post / Publish: Nate does.
const POST_SCRIPT: &str = r#"function (data) {
  const state = window.__socialspacePostState || (window.__socialspacePostState = { attached: false, filled: {}, posted: false, nexts: 0, lastClick: 0, auto: true });
  // The moment Nate clicks or types on the page himself, the script stops pressing anything (it still
  // fills fields once), so it never fights him or moves the steps under his hand.
  if (!window.__socialspaceHands) {
    window.__socialspaceHands = true;
    const takeOver = (event) => { if (event.isTrusted && !(event.target && event.target.closest && event.target.closest('#socialspace-post'))) state.auto = false; };
    document.addEventListener('pointerdown', takeOver, true);
    document.addEventListener('keydown', takeOver, true);
  }
  // YouTube always gets a thumbnail: the chosen moment, or else the first frame.
  if (data.coverMs == null && data.platform === 'youtube') data.coverMs = 0;
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const names = { tiktok: 'TikTok', youtube: 'YouTube', x: 'X' };
  const name = names[data.platform] || data.platform;
  const ours = (el) => !!(el && el.closest && el.closest('#socialspace-post, #socialspace-fill-banner, #socialspace-code'));
  const all = (selector) => Array.from(document.querySelectorAll(selector)).filter((el) => visible(el) && !ours(el));
  const first = (selectors) => {
    for (const selector of selectors) { const found = all(selector)[0]; if (found) return found; }
    return null;
  };
  /** The smallest visible element (of the given kinds) whose own text matches. */
  const byText = (pattern, selector) => all(selector || 'button, [role=button], [role=tab], a, span, div, label')
    .filter((el) => pattern.test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 80)
    .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0] || null;
  const now = () => Date.now();
  /** Clicks that open a section or step through the form, spaced out so the page can keep up. Never Post or Publish. */
  const press = (el) => {
    if (!el || !state.auto || now() - state.lastClick < 1500) return false;
    if (/^(post|publish|schedule|upload|save|done)$/i.test((el.textContent || '').trim())) return false;
    state.lastClick = now();
    el.click();
    return true;
  };
  const setText = (el, text, replace) => {
    el.focus();
    if (replace) document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
    el.style.outline = '2px solid #8b5cf6';
  };
  const fillOnce = (key, selectors, text, replace) => {
    if (!text || state.filled[key]) return;
    const el = first(selectors);
    if (!el) return;
    state.filled[key] = true;
    setText(el, text, replace);
  };
  const attachTo = (input, file) => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const fileInputs = (kind) => Array.from(document.querySelectorAll('input[type=file]')).filter((el) => !ours(el) &&
    (kind === 'image' ? /image|jpe?g|png/.test(el.accept || '') : (!el.accept || /video|mp4|mov|\*/.test(el.accept))));
  const switchOn = (row) => {
    const control = row && (row.querySelector('[role=switch], input[type=checkbox]'));
    if (!control) return null;
    return control.getAttribute('aria-checked') === 'true' || control.checked === true;
  };

  // The cover: the chosen moment of the video, drawn to a picture in the page.
  const makeCover = async () => {
    if (state.coverFile || state.coverTried || data.coverMs == null || !state.file) return;
    state.coverTried = true;
    try {
      const url = URL.createObjectURL(state.file);
      const video = document.createElement('video');
      video.muted = true; video.preload = 'auto'; video.src = url;
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; setTimeout(reject, 20000); });
      video.currentTime = Math.min(data.coverMs / 1000, Math.max(0, (video.duration || 0) - 0.05));
      await new Promise((resolve, reject) => { video.onseeked = resolve; setTimeout(reject, 10000); });
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      URL.revokeObjectURL(url);
      if (blob) state.coverFile = new File([blob], 'cover.jpg', { type: 'image/jpeg' });
    } catch (e) { state.coverFailed = true; }
  };

  const steps = {
    tiktok: () => {
      fillOnce('caption', ['.public-DraftEditor-content[contenteditable="true"]', '[data-e2e="caption_container"] [contenteditable="true"]', '.caption-editor [contenteditable="true"]'], data.text, true);
      if (!state.filled.caption) return;
      // "AI-generated content" sits under Show more; turning it on may ask to confirm.
      if (data.madeWithAi && !state.filled.ai) {
        const confirm = byText(/^Turn on$/i, 'button');
        if (confirm) { press(confirm); state.filled.ai = true; return; }
        const label = byText(/AI-generated content/i);
        if (!label) { if (!state.filled.more) { const more = byText(/^Show more$/i); if (more && press(more)) state.filled.more = true; } return; }
        let row = label;
        for (let i = 0; i < 5 && row && switchOn(row) === null; i++) row = row.parentElement;
        const on = switchOn(row);
        if (on === true) state.filled.ai = true;
        else if (on === false) press(row.querySelector('[role=switch], input[type=checkbox]'));
        return;
      }
      if (data.coverMs != null && !state.filled.cover && state.coverFile) {
        const input = fileInputs('image')[0];
        if (input && state.cover === 'tab') { attachTo(input, state.coverFile); state.cover = 'attached'; state.coverAt = now(); return; }
        if (state.cover === 'attached') {
          if (now() - state.coverAt < 2500) return;
          const ok = byText(/^(Confirm|Save|Done|Apply)$/i, 'button');
          if (ok) { state.lastClick = 0; ok.click(); state.filled.cover = true; }
          return;
        }
        if (state.cover === 'open') { const tab = byText(/^Upload cover$/i); if (tab && press(tab)) state.cover = 'tab'; else if (input) state.cover = 'tab'; return; }
        const edit = byText(/^Edit cover$/i);
        if (edit && press(edit)) state.cover = 'open';
      }
    },
    youtube: () => {
      fillOnce('title', ['#title-textarea #textbox', 'ytcp-social-suggestions-textbox#title-textarea [contenteditable="true"]'], data.title, true);
      fillOnce('description', ['#description-textarea #textbox', 'ytcp-social-suggestions-textbox#description-textarea [contenteditable="true"]'], data.text, true);
      if (!state.filled.title) return;
      if (data.coverMs != null && state.coverFile && !state.filled.cover) {
        // Only when YouTube offers its thumbnail upload: a Short or a channel that is not phone-verified has a
        // hidden file input, and a picture slipped into it makes YouTube fail to save the whole video.
        const offer = byText(/^Upload (file|thumbnail)$/i);
        const offered = offer && offer.getAttribute('aria-disabled') !== 'true' && !offer.hasAttribute('disabled') && !(offer.closest && offer.closest('[disabled], [aria-disabled="true"]'));
        const input = offered && (document.querySelector('input#file-loader') || fileInputs('image')[0]);
        if (input) { attachTo(input, state.coverFile); state.filled.cover = true; }
        else if (!state.coverWait) state.coverWait = now();
        else if (now() - state.coverWait > 8000) state.coverMissing = true;
      }
      const kids = document.querySelector('tp-yt-paper-radio-button[name="' + (data.madeForKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK') + '"]');
      if (!state.filled.kids && visible(kids)) { state.filled.kids = true; if (kids.getAttribute('aria-checked') !== 'true') kids.click(); }
      if (!state.filled.altered) {
        const altered = document.querySelector('tp-yt-paper-radio-button[name="' + (data.madeWithAi ? 'VIDEO_HAS_ALTERED_CONTENT_YES' : 'VIDEO_HAS_ALTERED_CONTENT_NO') + '"]');
        if (visible(altered)) { state.filled.altered = true; if (altered.getAttribute('aria-checked') !== 'true') altered.click(); }
        else if (!state.filled.more) { const more = document.querySelector('#toggle-button'); if (visible(more) && press(more)) { state.filled.more = true; state.moreAt = now(); } if (!state.auto) state.filled.altered = 'skipped'; return; }
        else if (now() - (state.moreAt || 0) > 6000) state.filled.altered = 'skipped';
        else return;
      }
      // Step through Video elements and Checks to Visibility, choose Public, and stop before Publish.
      const isPublic = document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"]');
      if (visible(isPublic)) {
        if (!state.filled.public && state.auto) { state.filled.public = true; if (isPublic.getAttribute('aria-checked') !== 'true') isPublic.click(); }
        state.auto = false;
        return;
      }
      // At most three Nexts (Details, Video elements, Checks), spaced out so each step can load.
      const next = document.querySelector('#next-button');
      if (state.filled.kids && state.nexts < 3 && now() - state.lastClick > 2500 && visible(next) && next.getAttribute('aria-disabled') !== 'true' && press(next)) state.nexts += 1;
    },
    x: () => {
      fillOnce('text', ['[data-testid="tweetTextarea_0"]', 'div[role="textbox"][contenteditable="true"]'], data.text, false);
    },
  };

  const reminders = () => {
    const list = [];
    if (data.coverMs != null && !state.filled.cover && data.platform !== 'x') {
      const at = data.cover || 'the start';
      if (state.coverFailed) list.push('Cover: the frame at ' + at + ' could not be made here; pick it on the page.');
      else if (state.coverMissing) list.push(data.platform === 'youtube' ? 'Thumbnail: YouTube only takes an uploaded thumbnail on a phone-verified channel, so it picks one itself for now.' : 'Cover: pick the frame at ' + at + ' under Edit cover.');
      else list.push('Cover: setting the frame at ' + at + '.');
    }
    if (data.platform === 'tiktok' && data.madeWithAi && !state.filled.ai) list.push('Turning on "AI-generated content" under Show more.');
    return list;
  };
  const status = () => {
    if (state.posted) return 'Posted. Socialspace marked it. You can close this window.';
    if (window.__socialspaceSignUpBlocked && !state.attached) return name + ' offered to create a new account, so this login has no account there. Socialspace filled nothing. Go back, sign in to @' + data.handle + ' with the email or username you made it with, and save that login on its card under Edit details.';
    const signingIn = location.hostname === 'accounts.google.com' || /\/login|\/i\/flow\//.test(location.pathname)
      || all('input[type=password], input[autocomplete="username"], input[name="text"][autocomplete]').length > 0;
    if (signingIn && !state.attached) return data.loginFilled
      ? 'Sign in as @' + data.handle + '. Its username and password are filled in step by step; press Next or Log in.'
      : 'Sign in as @' + data.handle + ' yourself: this profile has no login of its own saved in Social Space (it is on your main Gmail). Once signed in, it stays signed in.';
    if (data.fileNote && !state.attached) return data.fileNote;
    if (!state.attached) return 'Attaching ' + (data.fileName || 'the video') + '…';
    if (data.platform === 'youtube') {
      if (state.filled.public) return 'Everything is filled in and set to Public. Press Publish.';
      if (!state.auto || state.filled.altered) return 'Details are filled in. Go on with Next, choose Public, then press Publish.';
      return 'Filling in the details…';
    }
    if (reminders().length) return 'Filling in the details…';
    return 'Everything is filled in. Press Post.';
  };

  const box = () => {
    let el = document.getElementById('socialspace-post');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'socialspace-post';
    el.setAttribute('data-ss-keep', '');
    el.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;width:320px;max-height:60vh;overflow:auto;' +
      'background:#1b1b24;color:#f1f1f6;border:1px solid #8b5cf6;border-radius:12px;padding:12px 14px;' +
      'font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4)';
    document.body.appendChild(el);
    return el;
  };
  const copyButton = (label, text) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = 'margin:6px 6px 0 0;padding:4px 10px;border-radius:8px;border:1px solid #8b5cf6;background:transparent;color:#e9e3ff;cursor:pointer;font:inherit';
    button.onclick = () => navigator.clipboard.writeText(text).then(() => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = label; }, 1500); });
    return button;
  };
  const render = (text) => {
    const el = box();
    el.textContent = '';
    const head = document.createElement('strong');
    head.textContent = 'Socialspace · ' + name + (data.handle ? ' as @' + data.handle : '');
    head.style.display = 'block';
    el.appendChild(head);
    const line = document.createElement('div');
    line.textContent = text;
    line.style.margin = '4px 0';
    el.appendChild(line);
    for (const item of reminders()) {
      const row = document.createElement('div');
      row.textContent = '• ' + item;
      row.style.opacity = '.85';
      el.appendChild(row);
    }
    if (!state.attached && !state.posted && data.uploadUrl && !fileInputs('video').length) {
      const go = document.createElement('a');
      go.href = data.uploadUrl;
      go.textContent = 'Go to the upload page';
      go.style.cssText = 'display:inline-block;margin:6px 6px 0 0;color:#c4b5fd';
      el.appendChild(go);
    }
    if (data.title && data.platform === 'youtube') el.appendChild(copyButton('Copy title', data.title));
    if (data.text) el.appendChild(copyButton(data.platform === 'youtube' ? 'Copy description' : 'Copy caption', data.text));
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.textContent = 'Hide';
    hide.style.cssText = 'margin:6px 0 0;padding:4px 10px;border:0;background:transparent;color:#aaa;cursor:pointer;font:inherit';
    hide.onclick = () => { state.hidden = true; el.remove(); };
    el.appendChild(hide);
  };

  const success = () => {
    const text = (document.body && document.body.innerText) || '';
    if (data.platform === 'youtube') return state.attached && /Video published|Video scheduled|Video saved as (private|unlisted|public)/i.test(text);
    if (data.platform === 'x') return /Your post was sent/i.test(text);
    if (data.platform === 'tiktok') return state.attached && (/Your video (has been|was) (uploaded|posted)|Video (published|posted)/i.test(text) || /\/tiktokstudio\/content/.test(location.pathname));
    return false;
  };
  const markPosted = () => {
    if (state.posted) return;
    state.posted = true;
    try { history.replaceState(history.state, '', location.pathname + location.search + '#socialspace-posted'); } catch (e) { /* the app asks when the window closes */ }
  };
  window.__socialspacePost = {
    fileReady: (fileName, mime) => {
      try {
        const parts = (window.__socialspaceParts || []).map((part) => Uint8Array.from(atob(part), (c) => c.charCodeAt(0)));
        window.__socialspaceParts = null;
        state.file = new File(parts, fileName, { type: mime });
        makeCover();
        tick();
      } catch (e) { data.fileNote = 'The video could not be attached here: pick it on the page.'; tick(); }
    },
    fileFailed: (note) => { data.fileNote = note; tick(); },
  };
  let last = '';
  const tick = () => {
    if (!document.body) return;
    if (!state.attached && state.file) {
      const input = fileInputs('video')[0];
      if (input) { attachTo(input, state.file); state.attached = true; }
    }
    if (state.attached && !state.posted) { try { (steps[data.platform] || (() => {}))(); } catch (e) { console.warn('[Socialspace]', e); } }
    if (success()) markPosted();
    const text = status() + '|' + reminders().join('|');
    if (!state.hidden && (text !== last || !document.getElementById('socialspace-post'))) { last = text; render(status()); }
  };
  clearInterval(window.__socialspacePostTimer);
  window.__socialspacePostTimer = setInterval(tick, 1000);
  tick();
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> url::Url {
        value.parse().unwrap()
    }

    #[test]
    fn youtube_thumbnail_only_goes_where_youtube_offers_an_upload() {
        let youtube = POST_SCRIPT.split("youtube: () => {").nth(1).unwrap().split("x: () => {").next().unwrap();
        let guard = youtube.find("const offered").unwrap();
        assert!(guard < youtube.find("attachTo(input, state.coverFile)").unwrap());
        assert!(youtube.contains("const input = offered &&"));
    }

    #[test]
    fn brand_windows_never_use_webview_autofill() {
        let source = include_str!("posting.rs");
        let builder = source.split("fn build_window(").nth(1).unwrap().split(".build()").next().unwrap();
        assert!(builder.contains(".general_autofill_enabled(false)"));
        let site = include_str!("browser.rs").split("fn make_window(").nth(1).unwrap().split(".build()").next().unwrap();
        assert!(site.contains(".general_autofill_enabled(false)"));
    }

    #[test]
    fn instagram_has_no_upload_page() {
        assert!(upload_url(Platform::Instagram).is_none());
        for platform in [Platform::Tiktok, Platform::Youtube, Platform::X] {
            let page = url(upload_url(platform).unwrap());
            assert!(crate::browser::allowed_navigation(&page, false));
            assert!(on_social(&page));
        }
    }

    #[test]
    fn sign_in_pages_are_recognised() {
        assert!(is_sign_in(&url("https://accounts.google.com/v3/signin/identifier?x=1")));
        assert!(is_sign_in(&url("https://www.tiktok.com/login/phone-or-email/email")));
        assert!(is_sign_in(&url("https://x.com/i/flow/login")));
        assert!(!is_sign_in(&url("https://x.com/compose/post")));
        assert!(is_sign_in(&url("https://www.instagram.com/accounts/login/")));
        assert!(!may_fill_page(&url("https://x.com/compose/post")));
        assert!(!may_fill_page(&url("https://mobile.twitter.com/i/flow/login")));
        assert!(may_fill_page(&url("https://www.tiktok.com/tiktokstudio/upload")));
        assert!(!is_sign_in(&url("https://www.tiktok.com/tiktokstudio/upload")));
    }

    #[test]
    fn posted_only_when_the_page_shows_it() {
        assert!(shows_posted(Platform::X, &url("https://x.com/home#socialspace-posted"), false));
        assert!(!shows_posted(Platform::X, &url("https://x.com/home"), true));
        assert!(shows_posted(Platform::Tiktok, &url("https://www.tiktok.com/tiktokstudio/content"), true));
        assert!(!shows_posted(Platform::Tiktok, &url("https://www.tiktok.com/tiktokstudio/content"), false));
        assert!(!shows_posted(Platform::Youtube, &url("https://studio.youtube.com/channel/x/videos"), true));
    }

    #[test]
    fn only_video_files_are_attached() {
        assert!(attachable("").is_err());
        assert!(attachable("C:\\Windows\\win.ini").is_err());
        assert!(attachable("relative.mp4").is_err());
    }

    #[test]
    fn profile_pages_are_built_from_safe_usernames() {
        assert_eq!(profile_url(Platform::Tiktok, "@animals.daily").as_deref(), Some("https://www.tiktok.com/@animals.daily"));
        assert_eq!(profile_url(Platform::Youtube, "Animals").as_deref(), Some("https://www.youtube.com/@Animals/videos"));
        assert_eq!(profile_url(Platform::X, "animals_x").as_deref(), Some("https://x.com/animals_x"));
        assert_eq!(profile_url(Platform::Instagram, "animals").as_deref(), Some("https://www.instagram.com/animals/"));
        assert!(profile_url(Platform::X, "").is_none());
        assert!(profile_url(Platform::X, "a/../b").is_none());
        assert!(profile_url(Platform::X, "a b").is_none());
        for platform in [Platform::Tiktok, Platform::Youtube, Platform::X, Platform::Instagram] {
            let page: url::Url = profile_url(platform, "animals").unwrap().parse().unwrap();
            assert!(crate::browser::allowed_navigation(&page, false));
        }
    }

    #[test]
    fn no_profile_means_no_sign_in_fill() {
        assert!(brand_sign_in(&None, Platform::Tiktok, "animals", "a@b.c", Some("pw".into())).unwrap().is_none());
        assert!(brand_sign_in(&Some(String::new()), Platform::X, "animals", "", None).unwrap().is_none());
        assert!(brand_sign_in(&Some("a1".into()), Platform::Tiktok, "animals", "x+animals@example.com", None).unwrap().is_some());
    }

    #[test]
    fn x_is_manual_and_tiktok_sign_in_uses_username_without_sign_up() {
        assert!(!may_automate(Platform::X));
        assert!(may_automate(Platform::Tiktok));
        assert!(brand_sign_in(&Some("a1".into()), Platform::X, "@animals", "x+animals@example.com", Some("secret".into())).unwrap().is_none());
        let tiktok = brand_sign_in(&Some("a1".into()), Platform::Tiktok, "@animals", "x+animals@example.com", None).unwrap().unwrap();
        assert!(tiktok.contains("\"username\":\"animals\"") && tiktok.contains("\"signInOnly\":true"));
        let yt = brand_sign_in(&Some("a1".into()), Platform::Youtube, "animals", "x+animals@example.com", None).unwrap().unwrap();
        assert!(yt.contains("x+animals@example.com"));
        assert_eq!(window_verb("video-1"), "Post on");
        assert_eq!(window_verb(""), "Profile on");
    }

    #[test]
    fn long_text_is_refused() {
        let request: PostRequest = serde_json::from_value(serde_json::json!({
            "platform": "tiktok", "brandId": "b1", "videoId": "v1", "text": "a".repeat(MAX_TEXT_CHARS + 1)
        }))
        .unwrap();
        assert!(check(&request).is_err());
        let fine: PostRequest = serde_json::from_value(serde_json::json!({ "platform": "x", "brandId": "b1", "videoId": "v1", "text": "hi" })).unwrap();
        assert!(check(&fine).is_ok());
    }
}

/// Where each social edits a profile's picture, name and bio. TikTok edits it on the profile page itself
/// (Edit profile), so it needs the handle.
pub(crate) fn profile_edit_url(platform: Platform, handle: &str) -> Option<String> {
    match platform {
        Platform::Instagram => Some("https://www.instagram.com/accounts/edit/".into()),
        Platform::X => Some("https://x.com/settings/profile".into()),
        Platform::Youtube => Some("https://studio.youtube.com/".into()),
        Platform::Tiktok => profile_url(Platform::Tiktok, handle),
        // The Page itself, where Edit opens its details.
        Platform::Facebook => profile_url(Platform::Facebook, handle),
    }
}

/// TikTok's profile page signs in through a pop-up that opens on the QR-code screen, which the app
/// cannot fill. While the brand's folder is not signed in to TikTok, the window starts on TikTok's
/// email-and-password sign-in instead, and TikTok returns to the profile page afterwards.
pub(crate) fn signed_out_entry(platform: Platform, address: &str, signed_in: bool) -> String {
    if platform != Platform::Tiktok || signed_in {
        return address.to_owned();
    }
    let mut login = url::Url::parse("https://www.tiktok.com/login/phone-or-email/email").expect("valid TikTok sign-in URL");
    login.query_pairs_mut().append_pair("redirect_url", address);
    login.into()
}

/// What the page banner says until the editor shows up, since some socials need a click to open it.
fn profile_edit_note(platform: Platform) -> &'static str {
    match platform {
        Platform::Instagram => "Socialspace fills the picture, name, bio and website here. Check them, then press Submit yourself.",
        Platform::X => "Enter the picture, name, bio and website on X yourself, then press Save yourself.",
        Platform::Tiktok => "Press Edit profile: the picture, name and bio fill in as it opens. Check them, then press Save yourself.",
        Platform::Youtube => "Open Customization, then Profile: the picture, name and description fill in. Keywords are under Settings, Channel. Press Publish or Save yourself.",
        Platform::Facebook => "Press Edit on the Page: the picture, name and bio fill in as it opens. Check them, then press Save yourself.",
    }
}

/// A brand profile's edit page, filled for Nate to check and save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileEditRequest {
    platform: Platform,
    brand_id: String,
    #[serde(default)]
    account_id: Option<String>,
    handle: String,
    #[serde(default)]
    email: String,
    fields: crate::autofill::FormFields,
    /// The brand picture at this social's size.
    #[serde(default)]
    image_path: Option<String>,
}

/// Opens the profile editor of a brand profile in the brand's own window (its sign-in), and fills the
/// picture, name, bio, website and keywords. It never presses Save, Submit or Publish: Nate does.
#[tauri::command]
pub async fn open_profile_editor(app: AppHandle, request: ProfileEditRequest) -> Result<String, String> {
    let address = profile_edit_url(request.platform, &request.handle).ok_or("This profile has no valid username yet. Add it under Edit details.")?;
    if request.email.len() > 320 {
        return Err("The account details are not valid.".into());
    }
    let profile_script = if may_automate(request.platform) {
        Some(crate::autofill::profile_edit_script(&request.fields, request.image_path.as_deref(), profile_edit_note(request.platform))?)
    } else { None };
    let dir = profile_dir(&app, &request.brand_id)?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not make the brand's browser folder.")?;
    let password = if may_automate(request.platform) {
        request.account_id.as_deref().filter(|id| !id.is_empty()).and_then(|id| crate::account_passwords::read(id).ok().flatten())
    } else { None };
    let sign_in_script = brand_sign_in(&request.account_id, request.platform, &request.handle, &request.email, password)?;
    let post = PostRequest {
        platform: request.platform,
        brand_id: request.brand_id.clone(),
        video_id: String::new(),
        account_id: request.account_id.clone(),
        handle: request.handle.trim().trim_start_matches('@').to_owned(),
        email: request.email.clone(),
        video_path: String::new(),
        title: String::new(),
        text: String::new(),
        made_with_ai: false,
        made_for_kids: false,
        cover: String::new(),
        cover_ms: None,
    };
    let posting = std::sync::Arc::new(Posting { request: post, config_script: None, sign_in_script, profile_script, file: None, shared_session: Default::default() });
    let address = signed_out_entry(request.platform, &address, crate::sign_in_state::known_signed_in(&app, &request.brand_id, request.platform));
    let url: url::Url = address.parse().map_err(|_| "Invalid profile address.")?;
    open_signed_in(&app, url, dir, posting).map(|window| window.label().to_owned())
}

#[cfg(test)]
mod profile_edit_tests {
    use super::*;

    #[test]
    fn resets_open_each_socials_forgot_password_page() {
        assert!(reset_url(Platform::Youtube).is_none());
        for platform in [Platform::Instagram, Platform::X, Platform::Tiktok] {
            let page: url::Url = reset_url(platform).unwrap().parse().unwrap();
            assert!(crate::browser::allowed_navigation(&page, false) && on_social(&page));
        }
        assert!(save_reset_password("nothing-pending".into()).is_err());
    }

    #[test]
    fn instagram_settings_open_in_the_brand_window() {
        let page: url::Url = settings_url(Platform::Instagram).unwrap().parse().unwrap();
        assert!(crate::browser::allowed_navigation(&page, false) && on_social(&page));
        assert!(settings_url(Platform::Tiktok).is_none());
        let request: ProfileRequest = serde_json::from_value(serde_json::json!({ "platform": "instagram", "brandId": "b", "handle": "mia", "target": "settings" })).unwrap();
        assert_eq!(request.target, ProfileTarget::Settings);
        let request: ProfileRequest = serde_json::from_value(serde_json::json!({ "platform": "instagram", "brandId": "b", "handle": "mia" })).unwrap();
        assert_eq!(request.target, ProfileTarget::Profile);
    }

    #[test]
    fn each_social_opens_its_profile_editor() {
        assert_eq!(profile_edit_url(Platform::Instagram, "").as_deref(), Some("https://www.instagram.com/accounts/edit/"));
        assert_eq!(profile_edit_url(Platform::X, "mia").as_deref(), Some("https://x.com/settings/profile"));
        assert_eq!(profile_edit_url(Platform::Tiktok, "@massage.with.mia").as_deref(), Some("https://www.tiktok.com/@massage.with.mia"));
        assert!(profile_edit_url(Platform::Tiktok, "").is_none());
        assert!(profile_edit_url(Platform::Tiktok, "bad/handle").is_none());
        assert_eq!(signed_out_entry(Platform::Tiktok, "https://www.tiktok.com/@mia", false),
            "https://www.tiktok.com/login/phone-or-email/email?redirect_url=https%3A%2F%2Fwww.tiktok.com%2F%40mia");
        assert_eq!(signed_out_entry(Platform::Tiktok, "https://www.tiktok.com/@mia", true), "https://www.tiktok.com/@mia");
        assert_eq!(signed_out_entry(Platform::X, "https://x.com/settings/profile", false), "https://x.com/settings/profile");
        for platform in [Platform::Instagram, Platform::X, Platform::Tiktok, Platform::Youtube] {
            assert!(profile_edit_note(platform).contains("yourself"));
            assert!(profile_edit_url(platform, "mia").unwrap().starts_with("https://"));
        }
    }

    #[test]
    fn the_editor_fill_replaces_once_keeps_watching_and_never_submits() {
        let fields: crate::autofill::FormFields = serde_json::from_value(serde_json::json!({ "bio": "Calm hands", "keywords": "massage, relaxation" })).unwrap();
        let script = crate::autofill::profile_edit_script(&fields, None, profile_edit_note(Platform::Youtube)).unwrap();
        assert!(script.contains(r#""replace":true"#) && script.contains(r#""watch":true"#));
        assert!(script.contains(r#""keywords":"massage, relaxation""#));
        assert!(script.contains("Customization"));
        assert!(!script.contains("requestSubmit") && !script.contains(".submit("));
        assert!(crate::autofill::profile_edit_script(&fields, None, &"x".repeat(400)).is_err());
    }
}
