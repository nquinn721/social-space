//! Publishing to an Instagram professional account through Meta's official API.
//!
//! Two kinds of token work:
//! - an Instagram User token ("Instagram API with Instagram Login", starts with `IG`),
//!   which needs no Facebook Page and is used against graph.instagram.com. It lasts
//!   60 days and is refreshed here while the app is in use;
//! - a Facebook Page token ("Instagram API with Facebook Login"), used against
//!   graph.facebook.com. Only this kind may upload a video file straight from this PC.
//!
//! Tokens live in Windows Credential Manager, never in the workspace file.
//! Profile details (username, name, bio, picture) cannot be changed through this API.

use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::{Host, Url};

const API_VERSION: &str = "v25.0";
const FACEBOOK_HOST: &str = "https://graph.facebook.com";
const INSTAGRAM_HOST: &str = "https://graph.instagram.com";
const UPLOAD_HOST: &str = "https://rupload.facebook.com/ig-api-upload";
const KEYRING_SERVICE: &str = "social-manager-instagram-page";
const KEYRING_ENTRY: &str = "primary";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_POLLS: usize = 60;
const MAX_CAPTION_LENGTH: usize = 2_200;
const MAX_HASHTAGS: usize = 30;
const MAX_VIDEO_BYTES: u64 = 300 * 1024 * 1024;
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov"];
/// Instagram tokens can be refreshed once they are a day old; doing it weekly keeps them far from expiry.
const REFRESH_AFTER_SECS: u64 = 7 * 24 * 60 * 60;
const INSTAGRAM_TOKEN_PREFIX: &str = "IG";
static ACTIVE: AtomicBool = AtomicBool::new(false);

struct Guard;
impl Guard {
    fn acquire() -> Result<Self, String> {
        ACTIVE
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "An Instagram operation is already in progress.".to_string())?;
        Ok(Self)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum LoginKind {
    /// Facebook Page token. Saved credentials from before this field existed are this kind.
    #[default]
    Facebook,
    Instagram,
}
impl LoginKind {
    fn for_token(token: &str) -> Self {
        if token.starts_with(INSTAGRAM_TOKEN_PREFIX) {
            Self::Instagram
        } else {
            Self::Facebook
        }
    }
    fn api_base(self) -> String {
        let host = match self {
            Self::Facebook => FACEBOOK_HOST,
            Self::Instagram => INSTAGRAM_HOST,
        };
        format!("{host}/{API_VERSION}")
    }
}

#[derive(Serialize, Deserialize)]
struct Credential {
    id: String,
    username: String,
    access_token: String,
    #[serde(default)]
    kind: LoginKind,
    /// Seconds since 1970 when the token was saved or last refreshed.
    #[serde(default)]
    refreshed_at: u64,
}
#[derive(Serialize, Deserialize)]
pub struct InstagramConnection {
    id: String,
    username: String,
    login: LoginKind,
}
#[derive(Deserialize, Serialize)]
pub struct InstagramPost {
    id: String,
}
#[derive(Deserialize)]
struct ContainerStatus {
    status_code: String,
}
#[derive(Deserialize)]
struct FacebookAccount {
    id: String,
    username: String,
}
#[derive(Deserialize)]
struct InstagramAccount {
    user_id: serde_json::Value,
    username: String,
}
#[derive(Deserialize)]
struct RefreshedToken {
    access_token: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
/// Each profile in the app keeps its own Instagram connection, saved under its profile id.
/// Connections made before that live under "primary" until a profile claims them.
pub(crate) fn slot(profile: Option<&str>) -> Result<String, String> {
    match profile.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(KEYRING_ENTRY.to_string()),
        Some(id) if id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') => Ok(id.to_string()),
        Some(_) => Err("Invalid profile.".into()),
    }
}
fn entry(slot: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, slot)
        .map_err(|_| "Could not access secure credential storage.".into())
}
fn load(slot: &str) -> Result<Option<Credential>, String> {
    match entry(slot)?.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
            "Saved Instagram credentials could not be read. Disconnect and reconnect.".into()
        }),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read Instagram credentials from secure storage.".into()),
    }
}
fn save(slot: &str, value: &Credential) -> Result<(), String> {
    let value =
        serde_json::to_string(value).map_err(|_| "Could not encode Instagram credentials.")?;
    entry(slot)?
        .set_password(&value)
        .map_err(|_| "Could not save Instagram credentials in secure storage.".into())
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
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit())
}
fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_whitespace)
}
/// Meta sometimes sends numeric IDs as JSON numbers and sometimes as strings.
fn id_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Number(number) => number.as_u64().map(|n| n.to_string()),
        _ => None,
    }
}
fn container_ready(status: &str) -> Result<bool, String> {
    match status {
        "FINISHED" => Ok(true),
        "IN_PROGRESS" => Ok(false),
        "ERROR" | "EXPIRED" | "PUBLISHED" => {
            Err("Instagram could not prepare the post. No publish request was sent.".into())
        }
        _ => Err(
            "Instagram returned an unknown processing status. No publish request was sent.".into(),
        ),
    }
}
fn validate_media_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "Enter a public HTTPS link to the file.")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Enter a public HTTPS link without credentials or a fragment.".into());
    }
    match url.host() {
        Some(Host::Domain(name))
            if name.contains('.')
                && !name.ends_with(".local")
                && !name.eq_ignore_ascii_case("localhost") =>
        {
            Ok(())
        }
        _ => Err("Enter a public HTTPS link with a domain name.".into()),
    }
}
fn validate_caption(caption: &str) -> Result<(), String> {
    if caption.chars().count() > MAX_CAPTION_LENGTH {
        return Err("Instagram captions must be 2,200 characters or fewer.".into());
    }
    if caption.split_whitespace().filter(|word| word.starts_with('#')).count() > MAX_HASHTAGS {
        return Err("Instagram allows at most 30 hashtags in a caption.".into());
    }
    Ok(())
}
fn validate_video_file(path: &Path, size: u64) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        return Err("Choose an MP4 or MOV video.".into());
    }
    if size == 0 {
        return Err("That video file is empty.".into());
    }
    if size > MAX_VIDEO_BYTES {
        return Err("Instagram Reels uploaded from this PC must be 300 MB or smaller.".into());
    }
    Ok(())
}
async fn result<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    stage: &str,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!("Instagram {stage} failed (HTTP {}). Check the account, Meta permissions, token, and media requirements.", response.status().as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| format!("Instagram returned an unreadable {stage} response."))
}

async fn verify(
    kind: LoginKind,
    account_id: &str,
    token: &str,
) -> Result<InstagramConnection, String> {
    let http = client()?;
    match kind {
        LoginKind::Instagram => {
            let response = http
                .get(format!("{}/me", kind.api_base()))
                .query(&[("fields", "user_id,username")])
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| "Could not reach Instagram to verify the token.")?;
            let account: InstagramAccount = result(response, "account lookup").await?;
            let id = id_text(&account.user_id)
                .filter(|id| valid_id(id))
                .ok_or("Instagram returned an unexpected account ID.")?;
            if !account_id.is_empty() && account_id != id {
                return Err(format!("This token belongs to @{}, not the account ID you entered. Leave the ID empty for Instagram tokens.", account.username));
            }
            Ok(InstagramConnection { id, username: account.username, login: kind })
        }
        LoginKind::Facebook => {
            if !valid_id(account_id) {
                return Err("Facebook Page tokens also need the numeric Instagram account ID.".into());
            }
            let response = http
                .get(format!("{}/{account_id}", kind.api_base()))
                .query(&[("fields", "id,username")])
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| "Could not reach Meta to verify the Instagram account.")?;
            let account: FacebookAccount = result(response, "account lookup").await?;
            if account.id != account_id {
                return Err(
                    "Meta returned an unexpected Instagram account. Check your account ID.".into(),
                );
            }
            Ok(InstagramConnection { id: account.id, username: account.username, login: kind })
        }
    }
}

/// Keeps an Instagram-login token alive. A failed refresh is not fatal: the old token still works
/// until it expires, and the next post tries again.
async fn refresh_if_due(slot: &str, mut credential: Credential) -> Credential {
    if credential.kind != LoginKind::Instagram
        || now_secs().saturating_sub(credential.refreshed_at) < REFRESH_AFTER_SECS
    {
        return credential;
    }
    let Ok(http) = client() else { return credential };
    let response = http
        .get(format!("{INSTAGRAM_HOST}/refresh_access_token"))
        .query(&[("grant_type", "ig_refresh_token"), ("access_token", credential.access_token.as_str())])
        .send()
        .await;
    let Ok(response) = response else { return credential };
    if let Ok(token) = result::<RefreshedToken>(response, "token refresh").await {
        if valid_token(&token.access_token) {
            credential.access_token = token.access_token;
            credential.refreshed_at = now_secs();
            let _ = save(slot, &credential);
        }
    }
    credential
}

async fn ready_credential(slot: &str, needs_file_upload: bool) -> Result<Credential, String> {
    let credential =
        load(slot)?.ok_or("Connect this Instagram profile before publishing.")?;
    if !valid_id(&credential.id) {
        return Err("Saved Instagram account ID is invalid. Reconnect your account.".into());
    }
    if needs_file_upload && credential.kind != LoginKind::Facebook {
        return Err("Posting a video file from this PC needs a Facebook Page token. With an Instagram token, post a Reel from a public link instead.".into());
    }
    Ok(refresh_if_due(slot, credential).await)
}

async fn create_container(
    http: &reqwest::Client,
    credential: &Credential,
    params: &[(&str, &str)],
) -> Result<String, String> {
    let response = http
        .post(format!("{}/{}/media", credential.kind.api_base(), credential.id))
        .bearer_auth(&credential.access_token)
        .form(params)
        .send()
        .await
        .map_err(|_| "Could not start the Instagram post. No publish request was sent.")?;
    let container: InstagramPost = result(response, "post preparation").await?;
    if !valid_id(&container.id) {
        return Err(
            "Instagram returned an invalid container ID. No publish request was sent.".into(),
        );
    }
    Ok(container.id)
}

async fn wait_until_ready(
    http: &reqwest::Client,
    credential: &Credential,
    container: &str,
) -> Result<(), String> {
    for attempt in 0..MAX_POLLS {
        if attempt > 0 {
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(POLL_INTERVAL))
                .await
                .map_err(|_| {
                    "Instagram processing check was interrupted. No publish request was sent."
                })?;
        }
        let response = http
            .get(format!("{}/{container}", credential.kind.api_base()))
            .query(&[("fields", "status_code")])
            .bearer_auth(&credential.access_token)
            .send()
            .await
            .map_err(|_| "Could not check Instagram processing. No publish request was sent.")?;
        let status: ContainerStatus = result(response, "processing check").await?;
        if container_ready(&status.status_code)? {
            return Ok(());
        }
    }
    Err("Instagram is still processing the post. No publish request was sent; try again later.".into())
}

// The final publishing request is never retried automatically: its outcome can be ambiguous.
async fn publish_container(
    http: &reqwest::Client,
    credential: &Credential,
    container: &str,
) -> Result<InstagramPost, String> {
    let response = http.post(format!("{}/{}/media_publish", credential.kind.api_base(), credential.id))
        .bearer_auth(&credential.access_token).form(&[("creation_id", container)]).send().await
        .map_err(|_| "Instagram publish outcome is unknown. Check Instagram before retrying; the post may have been published.")?;
    if !response.status().is_success() {
        return Err(format!("Instagram returned HTTP {} when publishing. Check Instagram before retrying; the post may have been published.", response.status().as_u16()));
    }
    response.json().await.map_err(|_| "Instagram's publish response was unreadable. Check Instagram before retrying; the post may have been published.".into())
}

async fn publish_from_url(slot: &str, media: (&str, &str), media_type: Option<&str>, caption: &str) -> Result<InstagramPost, String> {
    validate_media_url(media.1)?;
    validate_caption(caption)?;
    let credential = ready_credential(slot, false).await?;
    let http = client()?;
    let mut params = vec![media, ("caption", caption)];
    if let Some(media_type) = media_type {
        params.push(("media_type", media_type));
    }
    let container = create_container(&http, &credential, &params).await?;
    wait_until_ready(&http, &credential, &container).await?;
    publish_container(&http, &credential, &container).await
}

#[tauri::command]
pub async fn connect_instagram(
    account_id: Option<String>,
    access_token: String,
    profile: Option<String>,
) -> Result<InstagramConnection, String> {
    let slot = slot(profile.as_deref())?;
    let _guard = Guard::acquire()?;
    let account_id = account_id.unwrap_or_default();
    let account_id = account_id.trim();
    let access_token = access_token.trim();
    if !valid_token(access_token) {
        return Err("Paste the whole access token from Meta, with no spaces.".into());
    }
    store(&slot, account_id, access_token, LoginKind::for_token(access_token)).await
}

/// Verifies and saves a token whose kind is already known, e.g. from Business Login for Instagram.
pub(crate) async fn store(slot: &str, account_id: &str, access_token: &str, kind: LoginKind) -> Result<InstagramConnection, String> {
    let account = verify(kind, account_id, access_token).await?;
    save(slot, &Credential {
        id: account.id.clone(),
        username: account.username.clone(),
        access_token: access_token.into(),
        kind,
        refreshed_at: now_secs(),
    })?;
    Ok(account)
}

#[tauri::command]
pub fn instagram_connection(profile: Option<String>) -> Result<Option<InstagramConnection>, String> {
    Ok(load(&slot(profile.as_deref())?)?.map(|c| InstagramConnection {
        id: c.id,
        username: c.username,
        login: c.kind,
    }))
}

#[tauri::command]
pub fn disconnect_instagram(profile: Option<String>) -> Result<(), String> {
    let _guard = Guard::acquire()?;
    match entry(&slot(profile.as_deref())?)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove Instagram credentials from secure storage.".into()),
    }
}

#[tauri::command]
pub async fn publish_instagram_reel(
    video_url: String,
    caption: String,
    profile: Option<String>,
) -> Result<InstagramPost, String> {
    let _guard = Guard::acquire()?;
    publish_from_url(&slot(profile.as_deref())?, ("video_url", video_url.trim()), Some("REELS"), &caption).await
}

/// Posts one photo. Meta downloads it from the link, and it must be a JPEG.
#[tauri::command]
pub async fn publish_instagram_photo(
    image_url: String,
    caption: String,
    profile: Option<String>,
) -> Result<InstagramPost, String> {
    let _guard = Guard::acquire()?;
    publish_from_url(&slot(profile.as_deref())?, ("image_url", image_url.trim()), None, &caption).await
}

/// The Reel container's form fields. cover_ms picks the cover as that moment of the video
/// (Meta's thumb_offset); share_to_feed also shows the Reel in the profile's main feed.
fn reel_file_params(caption: &str, cover_ms: Option<u64>, share_to_feed: Option<bool>) -> Vec<(&'static str, String)> {
    let mut params = vec![("media_type", "REELS".to_string()), ("upload_type", "resumable".to_string()), ("caption", caption.to_string())];
    if let Some(ms) = cover_ms {
        params.push(("thumb_offset", ms.to_string()));
    }
    if let Some(share) = share_to_feed {
        params.push(("share_to_feed", share.to_string()));
    }
    params
}

/// Uploads a video from this PC as a Reel (Meta's resumable upload, Facebook Page tokens only).
#[tauri::command]
pub async fn publish_instagram_reel_file(
    path: String,
    caption: String,
    profile: Option<String>,
    cover_ms: Option<u64>,
    share_to_feed: Option<bool>,
) -> Result<InstagramPost, String> {
    let _guard = Guard::acquire()?;
    let slot = slot(profile.as_deref())?;
    validate_caption(&caption)?;
    let file = std::path::PathBuf::from(path.trim());
    let size = std::fs::metadata(&file)
        .map_err(|_| "Could not open that video file.")?
        .len();
    validate_video_file(&file, size)?;
    let credential = ready_credential(&slot, true).await?;
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(file))
        .await
        .map_err(|_| "Could not read that video file.")?
        .map_err(|_| "Could not read that video file.")?;
    let http = client()?;
    let params = reel_file_params(&caption, cover_ms, share_to_feed);
    let borrowed: Vec<(&str, &str)> = params.iter().map(|(key, value)| (*key, value.as_str())).collect();
    let container = create_container(&http, &credential, &borrowed).await?;
    let response = client_with(UPLOAD_TIMEOUT)?
        .post(format!("{UPLOAD_HOST}/{API_VERSION}/{container}"))
        .header("Authorization", format!("OAuth {}", credential.access_token))
        .header("offset", "0")
        .header("file_size", bytes.len().to_string())
        .body(bytes)
        .send()
        .await
        .map_err(|_| "The video upload to Instagram did not finish. No publish request was sent.")?;
    if !response.status().is_success() {
        return Err(format!("Instagram refused the video upload (HTTP {}). No publish request was sent.", response.status().as_u16()));
    }
    wait_until_ready(&http, &credential, &container).await?;
    publish_container(&http, &credential, &container).await
}

/// Moves a connection made before per-profile connections onto the profile it belongs to,
/// only when its Instagram username is that profile's username.
#[tauri::command]
pub fn claim_instagram_connection(profile: String, username: String) -> Result<Option<InstagramConnection>, String> {
    let _guard = Guard::acquire()?;
    let target = slot(Some(&profile))?;
    if target == KEYRING_ENTRY || load(&target)?.is_some() {
        return instagram_connection(Some(profile));
    }
    let wanted = username.trim().trim_start_matches('@').to_lowercase();
    match load(KEYRING_ENTRY)? {
        Some(old) if !wanted.is_empty() && old.username.to_lowercase() == wanted => {
            save(&target, &old)?;
            let _ = entry(KEYRING_ENTRY)?.delete_credential();
            Ok(Some(InstagramConnection { id: old.id, username: old.username, login: old.kind }))
        }
        _ => Ok(None),
    }
}

/// Lets the user pick a video Instagram accepts for a Reel upload.
#[tauri::command]
pub async fn choose_instagram_video() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a video for Instagram")
            .add_filter("Video", VIDEO_EXTENSIONS)
            .pick_file()
            .map(|path| {
                path.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "The selected path is not valid Unicode.".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "Could not open the video picker.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_profile_has_its_own_slot() {
        assert_eq!(slot(None).unwrap(), "primary");
        assert_eq!(slot(Some("  ")).unwrap(), "primary");
        assert_eq!(slot(Some("62919ea9-d027")).unwrap(), "62919ea9-d027");
        assert!(slot(Some("../x")).is_err());
    }

    #[test]
    fn only_finished_containers_can_be_published() {
        assert_eq!(container_ready("FINISHED"), Ok(true));
        assert_eq!(container_ready("IN_PROGRESS"), Ok(false));
        for status in ["ERROR", "EXPIRED", "PUBLISHED", "UNEXPECTED"] {
            assert!(container_ready(status).is_err());
        }
    }
    #[test]
    fn account_and_container_ids_must_be_numeric() {
        assert!(valid_id("17841400000000000"));
        for id in ["", "../me", "1?x=2", " 123", "abc"] {
            assert!(!valid_id(id));
        }
    }
    #[test]
    fn media_url_rejects_credentials_and_local_hosts() {
        assert!(validate_media_url("https://media.example.com/reel.mp4?signature=abc").is_ok());
        for url in [
            "http://example.com/a.mp4",
            "https://user:pass@example.com/a.mp4",
            "https://localhost/a.mp4",
            "https://127.0.0.1/a.mp4",
            "https://example.local/a.mp4",
            "https://example.com/a#fragment",
        ] {
            assert!(validate_media_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn token_kind_follows_meta_prefixes() {
        assert_eq!(LoginKind::for_token("IGAAbc123"), LoginKind::Instagram);
        assert_eq!(LoginKind::for_token("EAAGm0PX4ZCps"), LoginKind::Facebook);
        assert_eq!(LoginKind::Instagram.api_base(), "https://graph.instagram.com/v25.0");
        assert_eq!(LoginKind::Facebook.api_base(), "https://graph.facebook.com/v25.0");
    }
    #[test]
    fn credentials_saved_before_login_kinds_still_load_as_facebook() {
        let old = r#"{"id":"42","username":"softwings","access_token":"EAA1"}"#;
        let credential: Credential = serde_json::from_str(old).unwrap();
        assert_eq!(credential.kind, LoginKind::Facebook);
        assert_eq!(credential.refreshed_at, 0);
    }
    #[test]
    fn ids_are_read_from_strings_or_numbers() {
        assert_eq!(id_text(&serde_json::json!("1784")), Some("1784".into()));
        assert_eq!(id_text(&serde_json::json!(1784)), Some("1784".into()));
        assert_eq!(id_text(&serde_json::json!(null)), None);
    }
    #[test]
    fn video_files_must_be_mp4_or_mov_and_not_too_big() {
        assert!(validate_video_file(Path::new("C:/v/reel.MP4"), 10).is_ok());
        assert!(validate_video_file(Path::new("C:/v/reel.mov"), MAX_VIDEO_BYTES).is_ok());
        assert!(validate_video_file(Path::new("C:/v/reel.avi"), 10).is_err());
        assert!(validate_video_file(Path::new("C:/v/reel.mp4"), 0).is_err());
        assert!(validate_video_file(Path::new("C:/v/reel.mp4"), MAX_VIDEO_BYTES + 1).is_err());
    }
    #[test]
    fn reel_cover_and_feed_are_sent_only_when_chosen() {
        let plain = reel_file_params("hi", None, None);
        assert!(!plain.iter().any(|(key, _)| *key == "thumb_offset" || *key == "share_to_feed"));
        let chosen = reel_file_params("hi", Some(1500), Some(false));
        assert!(chosen.contains(&("thumb_offset", "1500".to_string())));
        assert!(chosen.contains(&("share_to_feed", "false".to_string())));
    }
    #[test]
    fn captions_are_limited() {
        assert!(validate_caption(&"a".repeat(MAX_CAPTION_LENGTH)).is_ok());
        assert!(validate_caption(&"a".repeat(MAX_CAPTION_LENGTH + 1)).is_err());
        assert!(validate_caption(&"#a ".repeat(30)).is_ok());
        assert!(validate_caption(&"#a ".repeat(31)).is_err());
    }
    #[test]
    fn client_rejects_plain_http() {
        tauri::async_runtime::block_on(async {
            assert!(client()
                .unwrap()
                .get("http://127.0.0.1:1")
                .send()
                .await
                .unwrap_err()
                .is_builder());
        });
    }
}
