//! Posting a video through the social's own upload page, in a visible app window, while its API
//! is not approved yet (TikTok Sandbox, YouTube audit) or not used (X).
//!
//! Each brand gets its own browser profile (cookie folder) for posting, so every brand stays signed in
//! to its own TikTok, YouTube and X account. The window opens the upload page, fills the sign-in form
//! with the account's saved username and password, attaches the video file, and fills in everything
//! else (caption, title, cover, AI label, audience, visibility). It never presses Sign in, Post or
//! Publish: Nate does, so publishing is his one click. When the page shows the post went
//! up, the app is told and marks the video as posted; otherwise it asks Nate when the window closes.

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
        Platform::Instagram => None,
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
        _ => false,
    }
}

/// The pages a posting window may fill: the social's own sites and Google's sign-in.
fn on_social(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            ["tiktok.com", "youtube.com", "x.com", "twitter.com", "accounts.google.com"]
                .iter()
                .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
        })
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
        Platform::Instagram => false,
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
    config_script: String,
    sign_in_script: Option<String>,
    file: Option<PathBuf>,
}

fn page_loaded(posting: &Posting, webview: &tauri::Webview) {
    let Ok(url) = webview.url() else { return };
    if !on_social(&url) {
        return;
    }
    if is_sign_in(&url) {
        if let Some(script) = &posting.sign_in_script {
            let _ = webview.eval(script);
        }
    }
    let _ = webview.eval(&posting.config_script);
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
    };
    let handle = &posting.request.handle;
    let title = if handle.is_empty() { format!("Socialspace · Post on {name}") } else { format!("Socialspace · Post on {name} as @{handle}") };
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(1200.0, 860.0)
        .data_directory(dir)
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

/// Opens the social's upload page for one video, signed in as the brand's profile, with the video
/// attached and the text filled in. Nate checks it and presses Post.
#[tauri::command]
pub async fn open_posting_window(app: AppHandle, request: PostRequest) -> Result<String, String> {
    check(&request)?;
    let address = upload_url(request.platform).ok_or("Instagram posts through its API, not a page.")?;
    let dir = profile_dir(&app, &request.brand_id)?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not make the brand's browser folder.")?;
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
    };
    let data = serde_json::to_string(&config).map_err(|_| "Could not prepare the post.")?;
    let config_script = format!("({POST_SCRIPT})({data});");
    let password = match request.account_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => crate::account_passwords::read(id).ok().flatten(),
        None => None,
    };
    let login = if request.platform == Platform::Youtube { request.email.as_str() } else { request.handle.as_str() };
    let sign_in_script = crate::autofill::sign_in_script(login, &request.email, password)?;
    let posting = std::sync::Arc::new(Posting { request: request.clone(), config_script, sign_in_script, file });
    let url: url::Url = address.parse().map_err(|_| "Invalid upload address.")?;
    let window = build_window(&app, url, dir, posting, None)?;
    let label = window.label().to_owned();
    watch(app, window, request);
    Ok(label)
}

/// Runs in the upload page. Shows a panel with the post (and Copy buttons as a fallback), attaches the
/// video once the app has handed it over, fills the caption and title once each, sets the cover, the
/// AI label and YouTube's audience, steps YouTube through to Visibility and picks Public, and watches
/// for the page saying the post went up. The one button it never presses is Post / Publish: Nate does.
const POST_SCRIPT: &str = r#"function (data) {
  const state = window.__socialspacePostState || (window.__socialspacePostState = { attached: false, filled: {}, posted: false, nexts: 0, lastClick: 0 });
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
    if (!el || now() - state.lastClick < 1500) return false;
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
        const input = document.querySelector('input#file-loader') || fileInputs('image')[0];
        if (input) { attachTo(input, state.coverFile); state.filled.cover = true; }
      }
      const kids = document.querySelector('tp-yt-paper-radio-button[name="' + (data.madeForKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK') + '"]');
      if (!state.filled.kids && visible(kids)) { state.filled.kids = true; if (kids.getAttribute('aria-checked') !== 'true') kids.click(); }
      if (!state.filled.altered) {
        const altered = document.querySelector('tp-yt-paper-radio-button[name="' + (data.madeWithAi ? 'VIDEO_HAS_ALTERED_CONTENT_YES' : 'VIDEO_HAS_ALTERED_CONTENT_NO') + '"]');
        if (visible(altered)) { state.filled.altered = true; if (altered.getAttribute('aria-checked') !== 'true') altered.click(); }
        else if (!state.filled.more) { const more = document.querySelector('#toggle-button'); if (visible(more) && press(more)) state.filled.more = true; return; }
        else return;
      }
      // Step through Video elements and Checks to Visibility, choose Public, and stop before Publish.
      const isPublic = document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"]');
      if (visible(isPublic)) { if (!state.filled.public) { state.filled.public = true; if (isPublic.getAttribute('aria-checked') !== 'true') isPublic.click(); } return; }
      const next = document.querySelector('#next-button');
      if (state.filled.kids && visible(next) && next.getAttribute('aria-disabled') !== 'true' && state.nexts < 4 && press(next)) state.nexts += 1;
    },
    x: () => {
      fillOnce('text', ['[data-testid="tweetTextarea_0"]', 'div[role="textbox"][contenteditable="true"]'], data.text, false);
    },
  };

  const reminders = () => {
    const list = [];
    if (data.coverMs != null && !state.filled.cover && data.platform !== 'x') list.push('Cover: the frame at ' + data.cover + (state.coverFailed ? ' could not be made here; pick it under Edit cover.' : ' is being set.'));
    if (data.platform === 'tiktok' && data.madeWithAi && !state.filled.ai) list.push('Turning on "AI-generated content" under Show more.');
    return list;
  };
  const status = () => {
    if (state.posted) return 'Posted. Socialspace marked it. You can close this window.';
    if (location.hostname === 'accounts.google.com' || /\/login/.test(location.pathname)) return 'Sign in as the brand. Its username and password are filled in; press Next or Log in.';
    if (data.fileNote && !state.attached) return data.fileNote;
    if (!state.attached) return 'Attaching ' + (data.fileName || 'the video') + '…';
    if (data.platform === 'youtube') return document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"]') && state.filled.public
      ? 'Everything is filled in and set to Public. Press Publish.' : 'Filling in the details…';
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
