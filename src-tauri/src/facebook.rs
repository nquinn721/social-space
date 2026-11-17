//! Posting Reels to a brand's Facebook Page through Meta's Graph API.
//!
//! It uses the same Meta app as Instagram (Facebook Login for Business with the saved configuration).
//! Connect opens Meta's approval window, the person picks the brand's Page and presses Continue, and the
//! Page's own access token is saved under the brand's Facebook profile in Windows Credential Manager,
//! never in the workspace file. A Page token made from a long-lived user token does not expire.
//!
//! Publishing is Meta's Reels flow: start an upload session on the Page, send the file to
//! rupload.facebook.com, finish with video_state=PUBLISHED, then wait for Meta to process it.
//! Pages cannot be created through the API, so the app opens Facebook's own "Create Page" form filled in.

use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::instagram_login::{self as meta, MetaApp};

const API_VERSION: &str = "v25.0";
const GRAPH: &str = "https://graph.facebook.com";
const UPLOAD_HOST: &str = "https://rupload.facebook.com/video-upload";
const KEYRING_SERVICE: &str = "social-manager-facebook-page";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_POLLS: usize = 72;
const MAX_DESCRIPTION: usize = 2_200;
const MAX_VIDEO_BYTES: u64 = 1024 * 1024 * 1024;
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov"];
/// What the Page token needs to list Pages and publish Reels on them.
pub(crate) const PAGE_PERMISSIONS: &[&str] = &["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

static ACTIVE: AtomicBool = AtomicBool::new(false);
static OPEN_WINDOW: Mutex<Option<String>> = Mutex::new(None);

struct Guard;
impl Guard {
    fn acquire() -> Result<Self, String> {
        ACTIVE
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "A Facebook upload or connection is already running. Wait for it to finish.".to_string())?;
        Ok(Self)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Serialize, Deserialize)]
struct Credential {
    page_id: String,
    name: String,
    access_token: String,
}

/// The Page a brand's Facebook profile posts to.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct FacebookPage {
    id: String,
    name: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct FacebookPost {
    id: String,
    /// The live Reel on facebook.com.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    permalink: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct PageEntry {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    tasks: Vec<String>,
}
#[derive(Deserialize)]
struct PageList {
    #[serde(default)]
    data: Vec<PageEntry>,
}
#[derive(Deserialize)]
struct Token {
    access_token: String,
}
#[derive(Deserialize)]
struct StartedUpload {
    video_id: String,
}
#[derive(Deserialize, Default)]
struct Phase {
    #[serde(default)]
    status: String,
    #[serde(default)]
    error: Option<PhaseError>,
}
#[derive(Deserialize)]
struct PhaseError {
    #[serde(default)]
    message: String,
}
#[derive(Deserialize, Default)]
struct VideoStatus {
    #[serde(default)]
    video_status: String,
    #[serde(default)]
    processing_phase: Option<Phase>,
    #[serde(default)]
    publishing_phase: Option<Phase>,
}
#[derive(Deserialize)]
struct VideoNode {
    #[serde(default)]
    status: Option<VideoStatus>,
    #[serde(default)]
    permalink_url: Option<String>,
}

/// Each Facebook profile in the app keeps its own Page connection, saved under its profile id.
fn slot(profile: &str) -> Result<String, String> {
    let id = profile.trim();
    if !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        Ok(id.to_string())
    } else {
        Err("Invalid profile.".into())
    }
}
fn entry(slot: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, slot).map_err(|_| "Could not access secure credential storage.".into())
}
fn load(slot: &str) -> Result<Option<Credential>, String> {
    match entry(slot)?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "The saved Facebook Page connection could not be read. Connect it again.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the Facebook connection from secure storage.".into()),
    }
}
fn save(slot: &str, value: &Credential) -> Result<(), String> {
    let value = serde_json::to_string(value).map_err(|_| "Could not encode the Facebook connection.")?;
    entry(slot)?
        .set_password(&value)
        .map_err(|_| "Could not save the Facebook connection in secure storage.".into())
}
fn client_with(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start the network client.".into())
}
fn client() -> Result<reqwest::Client, String> {
    client_with(REQUEST_TIMEOUT)
}
fn base() -> String {
    format!("{GRAPH}/{API_VERSION}")
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit())
}
fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_whitespace)
}
fn normalized(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Picks the brand's Page: the saved Page ID first, then the Page named like the brand, then the only Page.
/// Only Pages the person may post on (CREATE_CONTENT) and that came with a token count.
fn choose_page(pages: Vec<PageEntry>, page_id: Option<&str>, name: Option<&str>) -> Result<PageEntry, String> {
    let usable: Vec<PageEntry> = pages
        .into_iter()
        .filter(|page| valid_id(&page.id) && page.access_token.as_deref().is_some_and(valid_token))
        .filter(|page| page.tasks.is_empty() || page.tasks.iter().any(|task| task == "CREATE_CONTENT"))
        .collect();
    if let Some(id) = page_id.filter(|id| valid_id(id)) {
        if let Some(page) = usable.iter().find(|page| page.id == id) {
            return Ok(page.clone());
        }
    }
    if let Some(wanted) = name.map(normalized).filter(|name| !name.is_empty()) {
        if let Some(page) = usable.iter().find(|page| normalized(&page.name) == wanted) {
            return Ok(page.clone());
        }
    }
    match usable.len() {
        0 => Err(format!(
            "Meta did not share a Facebook Page you can post on. In the Meta window, tick the brand's Page. If no Page is offered, add the permissions {} to the Facebook Login for Business configuration in the Meta app, then press Connect again.",
            PAGE_PERMISSIONS.join(", ")
        )),
        1 => Ok(usable.into_iter().next().expect("one page")),
        _ => Err(format!(
            "Meta shared several Pages ({}) and none is named like this brand. Rename the Page to the brand name, or tick only the brand's Page in the Meta window.",
            usable.iter().map(|page| page.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Swaps a short user token for a long-lived one, so the Page tokens made from it never expire.
/// System-user tokens are already long-lived and are kept as they are.
async fn long_lived(http: &reqwest::Client, app: &MetaApp, token: &str) -> String {
    let response = http
        .get(format!("{}/oauth/access_token", base()))
        .query(&[
            ("grant_type", "fb_exchange_token"),
            ("client_id", app.app_id.as_str()),
            ("client_secret", app.app_secret.as_str()),
            ("fb_exchange_token", token),
        ])
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => match response.json::<Token>().await {
            Ok(long) if valid_token(&long.access_token) => long.access_token,
            _ => token.to_string(),
        },
        _ => token.to_string(),
    }
}

async fn pages_for(http: &reqwest::Client, token: &str) -> Result<Vec<PageEntry>, String> {
    let response = http
        .get(format!("{}/me/accounts", base()))
        .query(&[("fields", "id,name,access_token,tasks"), ("limit", "100")])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Could not reach Meta to list your Facebook Pages.")?;
    if !response.status().is_success() {
        return Err(format!(
            "Meta would not list your Facebook Pages ({}). Add the permissions {} to the Facebook Login for Business configuration, then press Connect again.",
            meta::meta_error(response).await,
            PAGE_PERMISSIONS.join(", ")
        ));
    }
    Ok(response.json::<PageList>().await.map(|list| list.data).unwrap_or_default())
}

/// Checks a Page token works for this Page and saves it under the profile.
async fn store(slot: &str, page: PageEntry) -> Result<FacebookPage, String> {
    let token = page.access_token.clone().filter(|token| valid_token(token)).ok_or("Meta returned no token for that Page.")?;
    let response = client()?
        .get(format!("{}/{}", base(), page.id))
        .query(&[("fields", "id,name")])
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| "Could not reach Meta to check the Page.")?;
    if !response.status().is_success() {
        return Err(format!("Meta did not accept the Page token ({}).", meta::meta_error(response).await));
    }
    #[derive(Deserialize)]
    struct Checked {
        id: String,
        #[serde(default)]
        name: String,
    }
    let checked: Checked = response.json().await.map_err(|_| "Meta returned an unreadable Page.")?;
    if checked.id != page.id {
        return Err("Meta returned a different Page than the one chosen.".into());
    }
    let name = if checked.name.is_empty() { page.name } else { checked.name };
    save(slot, &Credential { page_id: checked.id.clone(), name: name.clone(), access_token: token })?;
    Ok(FacebookPage { id: checked.id, name })
}

/// One click: opens Meta's approval window (the same Meta app and configuration as Instagram), waits for the
/// person to pick the brand's Page and press Continue, and saves that Page's token under the profile.
/// page_id: the Page's ID when the app knows it. name: the brand or Page name, used to pick among several Pages.
#[tauri::command]
pub async fn connect_facebook_page(app: AppHandle, profile: String, page_id: Option<String>, name: Option<String>) -> Result<FacebookPage, String> {
    let slot = slot(&profile)?;
    let _guard = match Guard::acquire() {
        Ok(guard) => guard,
        Err(reason) => {
            let open = OPEN_WINDOW.lock().ok().and_then(|open| open.clone()).and_then(|label| app.get_webview_window(&label));
            if let Some(window) = open {
                let _ = window.unminimize();
                let _ = window.set_focus();
                return Err("The Connect Facebook window is already open; it's in front now. Pick the Page there and press Continue.".into());
            }
            return Err(reason);
        }
    };
    let meta_app = meta::load_app()?.filter(|app| app.config_id.is_some()).ok_or("SETUP_NEEDED")?;
    let config_id = meta_app.config_id.clone().unwrap_or_default();
    let state = meta::random_state()?;
    let approval_url = meta::unified_authorize_url(&meta_app.app_id, &config_id, &state)?;
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    let label = format!("site-facebook-{}", &state[..8]);
    let caught = sender.clone();
    let expected = state.clone();
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(approval_url))
        .title("Connect Facebook Page")
        .inner_size(560.0, 780.0)
        .on_navigation(move |url| {
            if let Some(result) = meta::redirect_result(url, &expected) {
                let _ = caught.send(result.map_err(|reason| reason.replace("Instagram", "Facebook")));
                return false;
            }
            crate::browser::allowed_navigation(url, false)
        })
        .build()
        .map_err(|_| "Could not open the Facebook window.")?;
    let _ = window.set_focus();
    if let Ok(mut open) = OPEN_WINDOW.lock() {
        *open = Some(label.clone());
    }
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = sender.send(Err("The Facebook window was closed before access was allowed.".into()));
        }
    });
    let outcome = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(APPROVAL_TIMEOUT))
        .await
        .map_err(|_| "The Facebook approval could not finish.")?
        .map_err(|_| "The Facebook approval timed out. Press Connect again.".to_string());
    if let Ok(mut open) = OPEN_WINDOW.lock() {
        *open = None;
    }
    let _ = window.close();
    let code = outcome??;
    let token = meta::unified_exchange(&meta_app, &code).await?;
    if !valid_token(&token) {
        return Err("Meta returned an invalid token.".into());
    }
    let http = client()?;
    let token = long_lived(&http, &meta_app, &token).await;
    let pages = pages_for(&http, &token).await?;
    let page = choose_page(pages, page_id.as_deref().map(str::trim), name.as_deref())?;
    store(&slot, page).await
}

/// The Page this profile posts to, or None when it isn't connected.
#[tauri::command]
pub fn facebook_connection(profile: String) -> Result<Option<FacebookPage>, String> {
    Ok(load(&slot(&profile)?)?.map(|c| FacebookPage { id: c.page_id, name: c.name }))
}

/// Forgets this profile's Page connection; nothing changes on Facebook.
#[tauri::command]
pub fn disconnect_facebook(profile: String) -> Result<(), String> {
    match entry(&slot(&profile)?)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the Facebook connection from secure storage.".into()),
    }
}

fn validate_video_file(path: &Path, size: u64) -> Result<(), String> {
    let extension = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if !VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Facebook Reels need an MP4 or MOV video.".into());
    }
    if size == 0 {
        return Err("That video file is empty.".into());
    }
    if size > MAX_VIDEO_BYTES {
        return Err("That video is too large for a Facebook Reel.".into());
    }
    Ok(())
}
fn validate_description(text: &str) -> Result<(), String> {
    if text.chars().count() > MAX_DESCRIPTION {
        return Err("Facebook Reel descriptions must be 2,200 characters or fewer.".into());
    }
    Ok(())
}

/// Where Meta is with a Reel: Ok(true) once published, Ok(false) while still working, Err when it failed.
fn reel_done(status: &VideoStatus) -> Result<bool, String> {
    let failed = |phase: &Option<Phase>| phase.as_ref().filter(|phase| phase.status == "error").map(|phase| phase.error.as_ref().map(|e| e.message.clone()).unwrap_or_default());
    if let Some(message) = failed(&status.processing_phase).or_else(|| failed(&status.publishing_phase)) {
        let message: String = message.chars().take(200).collect();
        return Err(if message.is_empty() { "Facebook could not process the Reel.".into() } else { format!("Facebook could not process the Reel: {message}") });
    }
    if status.video_status == "error" {
        return Err("Facebook could not process the Reel.".into());
    }
    let published = status.publishing_phase.as_ref().is_some_and(|phase| phase.status == "complete");
    Ok(published || status.video_status == "ready" && status.publishing_phase.is_none())
}

/// Only links to a Reel or video on facebook.com may be opened from the app.
fn facebook_post_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && matches!(url.host_str(), Some("www.facebook.com") | Some("facebook.com") | Some("m.facebook.com"))
            && (url.path().starts_with("/reel/") || url.path().contains("/videos/") || url.path().starts_with("/watch"))
    })
}
/// Meta gives the Reel's link as a path ("/reel/123/") or a full address; anything else falls back to /reel/<id>.
fn reel_link(permalink: Option<&str>, video_id: &str) -> String {
    let candidate = match permalink.map(str::trim) {
        Some(path) if path.starts_with('/') => format!("https://www.facebook.com{path}"),
        Some(full) => full.to_string(),
        None => String::new(),
    };
    if facebook_post_url(&candidate) { candidate } else { format!("https://www.facebook.com/reel/{video_id}") }
}

fn check_publishing_identity(expected: Option<&str>, actual: &str) -> Result<(), String> {
    match expected {
        Some(id) if valid_id(id) && id == actual => Ok(()),
        _ => Err("The connected Facebook Page changed or could not be verified. Review the destination and try again.".into()),
    }
}

/// Uploads a video from this PC and publishes it as a Reel on the profile's Facebook Page.
/// The final publish request is never retried: its outcome can be ambiguous.
#[tauri::command]
pub async fn publish_facebook_reel_file(path: String, description: String, profile: String, expected_id: Option<String>) -> Result<FacebookPost, String> {
    let _guard = Guard::acquire()?;
    let slot = slot(&profile)?;
    validate_description(&description)?;
    let file = std::path::PathBuf::from(path.trim());
    let size = std::fs::metadata(&file).map_err(|_| "Could not open that video file.")?.len();
    validate_video_file(&file, size)?;
    let credential = load(&slot)?.ok_or("Connect this brand's Facebook Page before posting.")?;
    if !valid_id(&credential.page_id) {
        return Err("The saved Facebook Page ID is invalid. Connect the Page again.".into());
    }
    check_publishing_identity(expected_id.as_deref(), &credential.page_id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(file))
        .await
        .map_err(|_| "Could not read that video file.")?
        .map_err(|_| "Could not read that video file.")?;
    let http = client()?;
    let page = &credential.page_id;
    let token = credential.access_token.as_str();

    let response = http
        .post(format!("{}/{page}/video_reels", base()))
        .bearer_auth(token)
        .form(&[("upload_phase", "start")])
        .send()
        .await
        .map_err(|_| "Could not start the Facebook upload. Nothing was posted.")?;
    if !response.status().is_success() {
        return Err(format!("Facebook would not start the upload ({}). Nothing was posted.", meta::meta_error(response).await));
    }
    let started: StartedUpload = response.json().await.map_err(|_| "Facebook returned an unreadable upload session. Nothing was posted.")?;
    if !valid_id(&started.video_id) {
        return Err("Facebook returned an invalid video ID. Nothing was posted.".into());
    }
    let video = started.video_id;

    let response = client_with(UPLOAD_TIMEOUT)?
        .post(format!("{UPLOAD_HOST}/{API_VERSION}/{video}"))
        .header("Authorization", format!("OAuth {token}"))
        .header("offset", "0")
        .header("file_size", bytes.len().to_string())
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|_| "The video upload to Facebook did not finish. Nothing was posted.")?;
    if !response.status().is_success() {
        return Err(format!("Facebook refused the video upload ({}). Nothing was posted.", meta::meta_error(response).await));
    }

    let response = http
        .post(format!("{}/{page}/video_reels", base()))
        .bearer_auth(token)
        .form(&[("upload_phase", "finish"), ("video_id", video.as_str()), ("video_state", "PUBLISHED"), ("description", description.as_str())])
        .send()
        .await
        .map_err(|_| "Facebook's answer to Publish never arrived. Check the Page before trying again; the Reel may be up.")?;
    if !response.status().is_success() {
        return Err(format!("Facebook did not publish the Reel ({}). Check the Page before trying again.", meta::meta_error(response).await));
    }

    // Meta processes the Reel after Publish. Wait for it so a rejected video (too long, wrong shape) is reported.
    let mut permalink = None;
    for attempt in 0..MAX_POLLS {
        if attempt > 0 {
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(POLL_INTERVAL)).await.map_err(|_| "Checking the Reel was interrupted.")?;
        }
        let Ok(response) = http.get(format!("{}/{video}", base())).query(&[("fields", "status,permalink_url")]).bearer_auth(token).send().await else { continue };
        if !response.status().is_success() {
            continue;
        }
        let Ok(node) = response.json::<VideoNode>().await else { continue };
        permalink = node.permalink_url.or(permalink);
        if reel_done(&node.status.unwrap_or_default())? {
            break;
        }
    }
    Ok(FacebookPost { permalink: Some(reel_link(permalink.as_deref(), &video)), id: video })
}

/// Opens a published Reel in an app window.
#[tauri::command]
pub async fn open_facebook_post(app: AppHandle, url: String) -> Result<(), String> {
    if !facebook_post_url(url.trim()) {
        return Err("That is not a link to a Facebook Reel.".into());
    }
    crate::browser::open_remote(&app, url.trim(), false)
}

#[cfg(test)]
mod tests {
    #[test]
    fn publishing_requires_the_confirmed_page_id() {
        assert!(super::check_publishing_identity(Some("123"), "123").is_ok());
        for expected in [None, Some(""), Some("abc"), Some("456")] {
            assert!(super::check_publishing_identity(expected, "123").is_err());
        }
    }
    use super::*;

    fn page(id: &str, name: &str, token: Option<&str>, tasks: &[&str]) -> PageEntry {
        PageEntry { id: id.into(), name: name.into(), access_token: token.map(Into::into), tasks: tasks.iter().map(|t| t.to_string()).collect() }
    }

    #[test]
    fn the_brand_page_is_picked_by_id_then_name_then_only_one() {
        let pages = || vec![page("111", "Massage with Mia", Some("EAA1"), &["CREATE_CONTENT"]), page("222", "Animals", Some("EAA2"), &[])];
        assert_eq!(choose_page(pages(), Some("222"), Some("Massage with Mia")).unwrap().id, "222");
        assert_eq!(choose_page(pages(), None, Some("massage-with-mia")).unwrap().id, "111");
        assert!(choose_page(pages(), None, Some("Cooking")).unwrap_err().contains("several Pages"));
        assert_eq!(choose_page(vec![page("333", "Other", Some("EAA3"), &[])], None, Some("Mia")).unwrap().id, "333");
    }

    #[test]
    fn pages_without_a_token_or_posting_rights_are_skipped() {
        let pages = vec![page("1", "Mia", None, &[]), page("2", "Mia", Some("EAA"), &["ANALYZE"])];
        assert!(choose_page(pages, None, Some("Mia")).unwrap_err().contains("pages_manage_posts"));
    }

    #[test]
    fn reel_status_reads_meta_phases() {
        let parse = |json: &str| serde_json::from_str::<VideoStatus>(json).unwrap();
        assert_eq!(reel_done(&parse(r#"{"video_status":"processing","processing_phase":{"status":"in_progress"},"publishing_phase":{"status":"not_started"}}"#)), Ok(false));
        assert_eq!(reel_done(&parse(r#"{"video_status":"ready","publishing_phase":{"status":"complete"}}"#)), Ok(true));
        assert!(reel_done(&parse(r#"{"video_status":"error","processing_phase":{"status":"error","error":{"message":"Resolution too low."}}}"#)).unwrap_err().contains("Resolution too low"));
    }

    #[test]
    fn only_facebook_reel_links_open() {
        assert!(facebook_post_url("https://www.facebook.com/reel/123/"));
        assert!(facebook_post_url("https://www.facebook.com/MiaPage/videos/123/"));
        for url in ["http://www.facebook.com/reel/1", "https://evil.com/reel/1", "https://www.facebook.com.evil.com/reel/1", "https://www.facebook.com/settings"] {
            assert!(!facebook_post_url(url), "{url}");
        }
        assert_eq!(reel_link(Some("/reel/42/"), "42"), "https://www.facebook.com/reel/42/");
        assert_eq!(reel_link(Some("javascript:alert(1)"), "42"), "https://www.facebook.com/reel/42");
        assert_eq!(reel_link(None, "42"), "https://www.facebook.com/reel/42");
    }

    #[test]
    fn profiles_have_safe_slots() {
        assert_eq!(slot("62919ea9-d027").unwrap(), "62919ea9-d027");
        assert!(slot("").is_err());
        assert!(slot("../x").is_err());
    }

    #[test]
    fn only_reel_videos_are_accepted() {
        assert!(validate_video_file(Path::new("a.mp4"), 10).is_ok());
        assert!(validate_video_file(Path::new("a.gif"), 10).is_err());
        assert!(validate_video_file(Path::new("a.mp4"), 0).is_err());
    }
}
