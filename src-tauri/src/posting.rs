//! Brand windows: app windows with one browser profile (cookie folder) per brand, so every brand stays
//! signed in to its own TikTok, YouTube, X, Instagram and Facebook account. They open a brand profile's
//! page, its profile editor, its password reset, and Ayrshare's linking page (where each social is linked
//! for posting through Ayrshare). Sign-in pages get the brand profile's saved login; X is never scripted.

use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde::Deserialize;
use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::Platform;

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Which brand profile a window is for. Its saved login fills the social's sign-in page.
#[derive(Debug, Clone)]
pub struct WindowRequest {
    platform: Platform,
    brand_id: String,
    handle: String,
}

/// An Ayrshare linking window: it can land on any social's sign-in, so it holds every brand login.
struct LinkWindow {
    brand: String,
    /// Sign-in fill per social, for the brand's own profile there.
    logins: Vec<(Platform, String)>,
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
        "facebook.com" | "m.facebook.com" => path.starts_with("/login"),
        _ => false,
    }
}

/// The pages a posting window may fill: the social's own sites and Google's sign-in.
fn on_social(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            ["tiktok.com", "youtube.com", "x.com", "twitter.com", "instagram.com", "facebook.com", "accounts.google.com"]
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

/// One cookie folder per brand, so each brand stays signed in to its own accounts.
fn profile_dir(app: &AppHandle, brand_id: &str) -> Result<PathBuf, String> {
    let safe: String = brand_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    if safe.is_empty() {
        return Err("Choose the brand to post as.".into());
    }
    let base = app.path().app_local_data_dir().map_err(|_| "Could not find the app's data folder.")?;
    Ok(base.join("posting").join(safe))
}

struct Posting {
    request: WindowRequest,
    sign_in_script: Option<String>,
    /// A profile-edit window: fills the brand's picture, name, bio and keywords (never on a sign-in page).
    profile_script: Option<String>,
    link: Option<LinkWindow>,
    /// Set once the other PC's sign-in was put into this window's folder.
    shared_session: std::sync::atomic::AtomicBool,
}

/// The social a sign-in page belongs to (Google's is YouTube's).
fn social_of(url: &url::Url) -> Option<Platform> {
    let host = url.host_str()?.trim_start_matches("www.");
    let on = |site: &str| host == site || host.ends_with(&format!(".{site}"));
    if host == "accounts.google.com" { return Some(Platform::Youtube); }
    if on("tiktok.com") { return Some(Platform::Tiktok); }
    if on("instagram.com") { return Some(Platform::Instagram); }
    if on("facebook.com") { return Some(Platform::Facebook); }
    None
}

fn link_page_loaded(link: &LinkWindow, webview: &tauri::Webview) {
    if crate::browser::to_email_login(webview) {
        return;
    }
    let Ok(url) = webview.url() else { return };
    if !may_fill_page(&url) || !is_sign_in(&url) {
        return;
    }
    let script = social_of(&url).and_then(|social| link.logins.iter().find(|(platform, _)| *platform == social));
    if let Some((_, script)) = script {
        let _ = webview.eval(script);
    }
}

fn page_loaded(posting: &Posting, webview: &tauri::Webview) {
    if let Some(link) = &posting.link {
        return link_page_loaded(link, webview);
    }
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
    if let (Some(script), false) = (&posting.profile_script, is_sign_in(&url)) {
        let _ = webview.eval(script);
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
    let title = match &posting.link {
        Some(link) => format!("Socialspace · Link {}'s socials", link.brand),
        None if handle.is_empty() => format!("Socialspace · {name}"),
        None => format!("Socialspace · {name} as @{handle}"),
    };
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1200.0, 860.0)
        .data_directory(dir)
        // WebView2's own form autofill would offer whatever was typed in this brand window before (the
        // main Gmail, another profile's login) and fill it over the app's fill; the app fills logins itself.
        .general_autofill_enabled(false);
    let builder = if posting.link.is_some() || may_automate(posting.request.platform) {
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
    builder.build().map_err(|_| "Could not open the brand window.".into())
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
                let here: Vec<Platform> = [Platform::Tiktok, Platform::Youtube, Platform::X, Platform::Instagram, Platform::Facebook].into_iter()
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
/// login (TikTok, Instagram, Facebook), or the Google login a YouTube channel lives under.
/// Without one the sign-in page is left for Nate.
fn brand_sign_in(account_id: &Option<String>, platform: Platform, handle: &str, email: &str, password: Option<String>) -> Result<Option<String>, String> {
    if !may_automate(platform) { return Ok(None); }
    if account_id.as_deref().map_or(true, str::is_empty) {
        return Ok(None);
    }
    // TikTok signs in with the profile's username so a shared email cannot select another account.
    match platform {
        Platform::Youtube | Platform::Instagram | Platform::Facebook if !email.is_empty() => crate::autofill::sign_in_script(email, email, password),
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
        // The brand's own Facebook account: its username or numeric ID.
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
    let post = WindowRequest {
        platform: request.platform,
        brand_id: request.brand_id.clone(),
        handle: request.handle.trim().trim_start_matches('@').to_owned(),
    };
    let posting = std::sync::Arc::new(Posting { request: post, sign_in_script, profile_script: None, link: None, shared_session: Default::default() });
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
        Platform::Facebook => Some("https://www.facebook.com/login/identify/"),
        // YouTube channels sit under your own Google login, which the app never resets.
        Platform::Youtube => None,
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
    let post = WindowRequest {
        platform: request.platform,
        brand_id: request.brand_id.clone(),
        handle: request.handle.trim().trim_start_matches('@').to_owned(),
    };
    // The same fill runs on the reset page and on the sign-in page the social may return to afterwards,
    // where the new password is then already filled.
    let posting = std::sync::Arc::new(Posting { request: post, sign_in_script: Some(script.clone()), profile_script: Some(script), link: None, shared_session: Default::default() });
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

/// Opens Ayrshare's linking page in the brand's window. When a social asks to sign in on the way, its
/// page gets the brand profile's own saved login (never the main Google login or another brand's).
pub(crate) fn open_link_window(app: &AppHandle, brand_id: &str, brand: &str, url: url::Url, logins: Vec<crate::ayrshare::LinkLogin>) -> Result<(), String> {
    let dir = profile_dir(app, brand_id)?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not make the brand's browser folder.")?;
    let mut scripts = Vec::new();
    for login in logins {
        if scripts.iter().any(|(platform, _)| *platform == login.platform) {
            continue;
        }
        let account = Some(login.account_id.clone()).filter(|id| !id.is_empty());
        let password = if may_automate(login.platform) { account.as_deref().and_then(|id| crate::account_passwords::read(id).ok().flatten()) } else { None };
        if let Some(script) = brand_sign_in(&account, login.platform, &login.handle, &login.email, password)? {
            scripts.push((login.platform, script));
        }
    }
    let request = WindowRequest { platform: Platform::Youtube, brand_id: brand_id.to_owned(), handle: String::new() };
    let posting = std::sync::Arc::new(Posting { request, sign_in_script: None, profile_script: None, link: Some(LinkWindow { brand: brand.to_owned(), logins: scripts }), shared_session: Default::default() });
    let blank: url::Url = "about:blank".parse().expect("valid blank URL");
    let window = build_window(app, blank, dir, posting, None)?;
    window.navigate(url).map_err(|_| "Could not open Ayrshare's linking page.")?;
    let _ = window.set_focus();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> url::Url {
        value.parse().unwrap()
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
    fn sign_in_pages_are_recognised() {
        assert!(is_sign_in(&url("https://accounts.google.com/v3/signin/identifier?x=1")));
        assert!(is_sign_in(&url("https://www.tiktok.com/login/phone-or-email/email")));
        assert!(is_sign_in(&url("https://x.com/i/flow/login")));
        assert!(!is_sign_in(&url("https://x.com/compose/post")));
        assert!(is_sign_in(&url("https://www.instagram.com/accounts/login/")));
        assert!(is_sign_in(&url("https://www.facebook.com/login/?next=%2Freels%2Fcreate%2F")));
        assert!(!is_sign_in(&url("https://www.facebook.com/reels/create/")));
        assert!(!may_fill_page(&url("https://x.com/compose/post")));
        assert!(!may_fill_page(&url("https://mobile.twitter.com/i/flow/login")));
        assert!(may_fill_page(&url("https://www.tiktok.com/tiktokstudio/upload")));
    }

    #[test]
    fn linking_fills_the_sign_in_of_the_social_it_lands_on() {
        assert_eq!(social_of(&url("https://accounts.google.com/v3/signin/identifier")), Some(Platform::Youtube));
        assert_eq!(social_of(&url("https://www.tiktok.com/login/phone-or-email/email")), Some(Platform::Tiktok));
        assert_eq!(social_of(&url("https://www.instagram.com/accounts/login/")), Some(Platform::Instagram));
        assert_eq!(social_of(&url("https://m.facebook.com/login/")), Some(Platform::Facebook));
        assert_eq!(social_of(&url("https://x.com/i/flow/login")), None);
        assert_eq!(social_of(&url("https://profile.ayrshare.com/social-accounts")), None);
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
        let fb = brand_sign_in(&Some("a1".into()), Platform::Facebook, "bunnywhispers", "x+bunnywhispers@example.com", Some("pw".into())).unwrap().unwrap();
        assert!(fb.contains("x+bunnywhispers@example.com") && fb.contains("\"signInOnly\":true"));
        let yt = brand_sign_in(&Some("a1".into()), Platform::Youtube, "animals", "x+animals@example.com", None).unwrap().unwrap();
        assert!(yt.contains("x+animals@example.com"));
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
        Platform::Facebook => "Press Edit profile: the picture, name and bio fill in as it opens. Check them, then press Save yourself.",
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
    let post = WindowRequest {
        platform: request.platform,
        brand_id: request.brand_id.clone(),
        handle: request.handle.trim().trim_start_matches('@').to_owned(),
    };
    let posting = std::sync::Arc::new(Posting { request: post, sign_in_script, profile_script, link: None, shared_session: Default::default() });
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
