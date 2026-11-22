//! Posting and scheduling through Ayrshare (https://www.ayrshare.com/docs/apis).
//!
//! One Ayrshare account (its API key, saved under Settings) holds one Ayrshare profile per brand. Each
//! profile links that brand's own Instagram, Facebook, TikTok, YouTube and X through Ayrshare's hosted
//! linking page, which opens in the brand's own window (signed in as the brand). Posts go out with the
//! brand's Profile-Key, either right away or at a `scheduleDate`, and Ayrshare's history is what the app
//! reads back as the truth about what went up.
//!
//! Secrets (the API key, each brand's profile key, and the optional X app key pair X requires since
//! 2026-03-31) live in Windows Credential Manager, never in the workspace file.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::Platform;

const BASE: &str = "https://api.ayrshare.com/api";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Files up to this size go to /media/upload (kept 90 days); bigger ones through a presigned URL (30 days).
const SMALL_UPLOAD_BYTES: u64 = 30 * 1024 * 1024;
const MAX_UPLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_SECRET_BYTES: usize = 2_000;
const MAX_POST_BYTES: usize = 64 * 1024;

const API_KEY: &str = "api-key";
const X_KEY: &str = "x-api-key";
const X_SECRET: &str = "x-api-secret";

/// The socials Ayrshare posts to for the app, by Ayrshare's names.
const NETWORKS: [&str; 5] = ["instagram", "facebook", "tiktok", "youtube", "twitter"];

fn platform_of(network: &str) -> Option<Platform> {
    match network {
        "instagram" => Some(Platform::Instagram),
        "facebook" => Some(Platform::Facebook),
        "tiktok" => Some(Platform::Tiktok),
        "youtube" => Some(Platform::Youtube),
        "twitter" | "x" => Some(Platform::X),
        _ => None,
    }
}

// ---------- secrets ----------

fn valid_brand(brand_id: &str) -> Result<(), String> {
    if brand_id.is_empty() || brand_id.len() > 64 || !brand_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Choose a brand.".into());
    }
    Ok(())
}

fn profile_slot(brand_id: &str) -> Result<String, String> {
    valid_brand(brand_id)?;
    Ok(format!("profile-{brand_id}"))
}

fn clean_secret(value: &str, what: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_SECRET_BYTES || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(format!("Enter a valid {what}."));
    }
    Ok(value.to_owned())
}

#[cfg(windows)]
mod store {
    const SERVICE: &str = "social-manager-ayrshare";
    fn entry(slot: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, slot).map_err(|_| "Windows Credential Manager is unavailable.".into())
    }
    pub fn read(slot: &str) -> Result<Option<String>, String> {
        match entry(slot)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Could not read the saved Ayrshare key.".into()),
        }
    }
    pub fn write(slot: &str, value: &str) -> Result<(), String> {
        entry(slot)?.set_password(value).map_err(|_| "Could not save the Ayrshare key to Windows Credential Manager.".into())
    }
    pub fn delete(slot: &str) -> Result<(), String> {
        match entry(slot)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove the saved Ayrshare key.".into()),
        }
    }
}

/// Outside Windows (development and tests) the keys live in memory only.
#[cfg(not(windows))]
mod store {
    use std::{collections::HashMap, sync::Mutex};
    static KEYS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
    pub fn read(slot: &str) -> Result<Option<String>, String> {
        Ok(KEYS.lock().map_err(|_| "Key store unavailable.")?.as_ref().and_then(|keys| keys.get(slot).cloned()))
    }
    pub fn write(slot: &str, value: &str) -> Result<(), String> {
        KEYS.lock().map_err(|_| "Key store unavailable.")?.get_or_insert_with(HashMap::new).insert(slot.to_owned(), value.to_owned());
        Ok(())
    }
    pub fn delete(slot: &str) -> Result<(), String> {
        if let Some(keys) = KEYS.lock().map_err(|_| "Key store unavailable.")?.as_mut() {
            keys.remove(slot);
        }
        Ok(())
    }
}

fn api_key() -> Result<String, String> {
    store::read(API_KEY)?.ok_or_else(|| "Connect Ayrshare under Settings first.".into())
}

fn profile_key(brand_id: &str) -> Result<String, String> {
    store::read(&profile_slot(brand_id)?)?.ok_or_else(|| "Set up posting for this brand first.".into())
}

fn x_keys() -> Result<Option<(String, String)>, String> {
    Ok(match (store::read(X_KEY)?, store::read(X_SECRET)?) {
        (Some(key), Some(secret)) => Some((key, secret)),
        _ => None,
    })
}

/// The Ayrshare keys for the plain-text accounts export: API key, X app keys and each brand's profile key.
pub(crate) fn export_keys(brands: &[(String, String)]) -> Result<Value, String> {
    let mut profiles = Vec::new();
    for (id, name) in brands {
        if let Ok(slot) = profile_slot(id) {
            if let Some(key) = store::read(&slot)? {
                profiles.push(json!({ "brand": name, "profileKey": key }));
            }
        }
    }
    Ok(json!({
        "apiKey": store::read(API_KEY)?,
        "xApiKey": store::read(X_KEY)?,
        "xApiSecret": store::read(X_SECRET)?,
        "brandProfiles": profiles,
    }))
}

// ---------- HTTP ----------

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().https_only(true).timeout(timeout).build().map_err(|_| "Could not reach Ayrshare.".into())
}

struct Call {
    method: reqwest::Method,
    path: String,
    profile: Option<String>,
    body: Option<Value>,
    x: bool,
}

impl Call {
    fn new(method: reqwest::Method, path: impl Into<String>) -> Self {
        Self { method, path: path.into(), profile: None, body: None, x: false }
    }
    fn profile(mut self, key: String) -> Self {
        self.profile = Some(key);
        self
    }
    fn body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }
    fn with_x(mut self, x: bool) -> Self {
        self.x = x;
        self
    }
}

/// The message Ayrshare gave for a failed call, from `message` or the first of `errors`.
pub(crate) fn error_message(value: &Value) -> Option<String> {
    let text = |item: &Value| item.get("message").and_then(Value::as_str).map(str::to_owned);
    text(value).or_else(|| value.get("errors").and_then(Value::as_array).and_then(|errors| errors.iter().find_map(text)))
        .or_else(|| value.get("posts").and_then(Value::as_array).and_then(|posts| posts.iter().find_map(error_message)))
}

/// Sends a call with the saved API key. Returns the JSON body and whether the HTTP status was a success.
async fn send(key: &str, call: Call) -> Result<(bool, Value), String> {
    let http = client(REQUEST_TIMEOUT)?;
    let mut request = http.request(call.method, format!("{BASE}/{}", call.path)).bearer_auth(key);
    if let Some(profile) = &call.profile {
        request = request.header("Profile-Key", profile);
    }
    if call.x {
        if let Some((x_key, x_secret)) = x_keys()? {
            request = request.header("X-Twitter-OAuth1-Api-Key", x_key).header("X-Twitter-OAuth1-Api-Secret", x_secret);
        }
    }
    if let Some(body) = &call.body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|_| "Could not reach Ayrshare. Check the internet connection.")?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Ayrshare did not accept the API key. Check it under Settings.".into());
    }
    Ok((status.is_success(), value))
}

/// Like `send`, but a failed call is an error with Ayrshare's message.
async fn expect(key: &str, call: Call, what: &str) -> Result<Value, String> {
    let (ok, value) = send(key, call).await?;
    if !ok {
        return Err(error_message(&value).map_or_else(|| format!("Ayrshare could not {what}."), |message| format!("Ayrshare could not {what}: {message}")));
    }
    Ok(value)
}

// ---------- account ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AyrshareStatus {
    /// An API key is saved.
    connected: bool,
    /// Ayrshare accepted the key just now (None when it could not be asked).
    working: Option<bool>,
    /// The X app key pair X requires is saved.
    x_keys: bool,
    /// The Ayrshare account's email or title, when Ayrshare says.
    account: Option<String>,
    detail: Option<String>,
}

async fn status_with(key: Option<String>) -> Result<AyrshareStatus, String> {
    let x_keys = x_keys()?.is_some();
    let Some(key) = key else {
        return Ok(AyrshareStatus { connected: false, working: None, x_keys, account: None, detail: None });
    };
    match send(&key, Call::new(reqwest::Method::GET, "user")).await {
        Ok((true, user)) => {
            let account = user.get("email").and_then(Value::as_str).or_else(|| user.get("title").and_then(Value::as_str)).map(str::to_owned);
            Ok(AyrshareStatus { connected: true, working: Some(true), x_keys, account, detail: None })
        }
        Ok((false, value)) => Ok(AyrshareStatus { connected: true, working: Some(false), x_keys, account: None, detail: error_message(&value) }),
        Err(message) if message.contains("did not accept") => Ok(AyrshareStatus { connected: true, working: Some(false), x_keys, account: None, detail: Some(message) }),
        Err(message) => Ok(AyrshareStatus { connected: true, working: None, x_keys, account: None, detail: Some(message) }),
    }
}

#[tauri::command]
pub async fn ayrshare_status() -> Result<AyrshareStatus, String> {
    status_with(store::read(API_KEY)?).await
}

/// Checks the key with Ayrshare and saves it only when Ayrshare accepts it.
#[tauri::command]
pub async fn ayrshare_save_key(api_key: String) -> Result<AyrshareStatus, String> {
    let key = clean_secret(&api_key, "Ayrshare API key")?;
    let status = status_with(Some(key.clone())).await?;
    if status.working != Some(true) {
        return Err(status.detail.unwrap_or_else(|| "Ayrshare did not accept this API key.".into()));
    }
    store::write(API_KEY, &key)?;
    Ok(status)
}

#[tauri::command]
pub fn ayrshare_disconnect() -> Result<(), String> {
    store::delete(API_KEY)
}

/// X needs your own X developer app's OAuth 1.0a key pair on every request (X bills the posts).
#[tauri::command]
pub fn ayrshare_save_x_keys(api_key: String, api_secret: String) -> Result<(), String> {
    let key = clean_secret(&api_key, "X API key")?;
    let secret = clean_secret(&api_secret, "X API key secret")?;
    store::write(X_KEY, &key)?;
    store::write(X_SECRET, &secret)
}

#[tauri::command]
pub fn ayrshare_remove_x_keys() -> Result<(), String> {
    store::delete(X_KEY)?;
    store::delete(X_SECRET)
}

// ---------- brand profiles ----------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandProfile {
    ref_id: String,
    title: String,
}

/// Creates the brand's Ayrshare profile and keeps its profile key.
#[tauri::command]
pub async fn ayrshare_create_profile(brand_id: String, title: String) -> Result<BrandProfile, String> {
    let slot = profile_slot(&brand_id)?;
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("The brand needs a name first.".into());
    }
    let key = api_key()?;
    let made = expect(&key, Call::new(reqwest::Method::POST, "profiles").body(json!({ "title": title })), "make a profile for this brand").await
        .map_err(|message| if message.contains("146") || message.to_lowercase().contains("already exists") {
            format!("Ayrshare already has a profile called {title}. Copy its Profile Key from the Ayrshare dashboard and press Use existing profile.")
        } else { message })?;
    let profile = made.get("profileKey").and_then(Value::as_str).ok_or("Ayrshare made the profile but sent no profile key. Copy it from the Ayrshare dashboard and press Use existing profile.")?;
    store::write(&slot, profile)?;
    Ok(BrandProfile {
        ref_id: made.get("refId").and_then(Value::as_str).unwrap_or_default().to_owned(),
        title: made.get("title").and_then(Value::as_str).unwrap_or(title).to_owned(),
    })
}

/// Uses a profile made in the Ayrshare dashboard: its key is checked with Ayrshare, then kept.
#[tauri::command]
pub async fn ayrshare_use_profile(brand_id: String, profile_key: String) -> Result<BrandProfile, String> {
    let slot = profile_slot(&brand_id)?;
    let profile = clean_secret(&profile_key, "Profile Key")?;
    let key = api_key()?;
    let user = expect(&key, Call::new(reqwest::Method::GET, "user").profile(profile.clone()), "find that profile").await?;
    store::write(&slot, &profile)?;
    Ok(BrandProfile {
        ref_id: user.get("refId").and_then(Value::as_str).unwrap_or_default().to_owned(),
        title: user.get("title").and_then(Value::as_str).unwrap_or_default().to_owned(),
    })
}

/// Forgets the brand's profile key on this PC. The profile and its posts stay in Ayrshare.
#[tauri::command]
pub fn ayrshare_forget_profile(brand_id: String) -> Result<(), String> {
    store::delete(&profile_slot(&brand_id)?)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSocial {
    platform: Platform,
    /// The account's username or channel/page name, as Ayrshare shows it.
    name: String,
    /// Ayrshare says the link must be renewed (TikTok asks every so often).
    refresh: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandSocials {
    /// This PC has the brand's profile key.
    has_profile: bool,
    linked: Vec<LinkedSocial>,
}

/// Reads which socials are linked from Ayrshare's /user answer for a profile.
pub(crate) fn linked_socials(user: &Value) -> Vec<LinkedSocial> {
    let active: Vec<&str> = user.get("activeSocialAccounts").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let names = user.get("displayNames").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut linked: Vec<LinkedSocial> = Vec::new();
    for network in active {
        let Some(platform) = platform_of(network) else { continue };
        if linked.iter().any(|item| item.platform == platform) {
            continue;
        }
        let entry = names.iter().find(|item| item.get("platform").and_then(Value::as_str) == Some(network));
        let field = |key: &str| entry.and_then(|item| item.get(key)).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned);
        let name = field("username").or_else(|| field("handle")).or_else(|| field("pageName")).or_else(|| field("channelTitle")).or_else(|| field("displayName")).unwrap_or_default();
        let refresh = entry.and_then(|item| item.get("refreshRequired")).is_some_and(|value| value.as_bool() == Some(true) || value.as_str().is_some_and(|text| !text.is_empty()));
        linked.push(LinkedSocial { platform, name, refresh });
    }
    linked
}

#[tauri::command]
pub async fn ayrshare_brand_socials(brand_id: String) -> Result<BrandSocials, String> {
    let Some(profile) = store::read(&profile_slot(&brand_id)?)? else {
        return Ok(BrandSocials { has_profile: false, linked: Vec::new() });
    };
    let key = api_key()?;
    let user = expect(&key, Call::new(reqwest::Method::GET, "user").profile(profile), "read this brand's linked socials").await?;
    Ok(BrandSocials { has_profile: true, linked: linked_socials(&user) })
}

/// A brand login the linking window may fill when a social asks to sign in.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkLogin {
    pub(crate) platform: Platform,
    pub(crate) account_id: String,
    #[serde(default)]
    pub(crate) handle: String,
    #[serde(default)]
    pub(crate) email: String,
}

/// Opens Ayrshare's linking page for the brand in the brand's own window, so each social's sign-in is
/// the brand's account (filled from its saved login), never the main Google or another brand.
#[tauri::command]
pub async fn ayrshare_open_linking(app: AppHandle, brand_id: String, brand_name: String, logins: Vec<LinkLogin>) -> Result<(), String> {
    let profile = profile_key(&brand_id)?;
    let key = api_key()?;
    let body = json!({ "allowedSocial": NETWORKS, "instagramLinkMethod": "instagram" });
    let session = send(&key, Call::new(reqwest::Method::POST, "profiles/link-sessions").profile(profile.clone()).body(body.clone()).with_x(true)).await?;
    let url = match session {
        (true, value) => value.get("url").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    };
    // Older accounts: the earlier linking call, which takes the profile key in the body.
    let url = match url {
        Some(url) => url,
        None => {
            let mut body = body;
            body["profileKey"] = json!(profile);
            let value = expect(&key, Call::new(reqwest::Method::POST, "profiles/generateJWT").body(body).with_x(true), "open the linking page").await?;
            value.get("url").and_then(Value::as_str).ok_or("Ayrshare sent no linking page.")?.to_owned()
        }
    };
    let url: url::Url = url.parse().map_err(|_| "Ayrshare sent an invalid linking page.")?;
    if url.scheme() != "https" {
        return Err("Ayrshare sent an invalid linking page.".into());
    }
    let title = brand_name.chars().take(80).collect::<String>();
    crate::posting::open_link_window(&app, &brand_id, &title, url, logins)
}

// ---------- posting ----------

fn content_type(path: &std::path::Path) -> (&'static str, &'static str) {
    match path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()).as_deref() {
        Some("mov") => ("mov", "video/quicktime"),
        _ => ("mp4", "video/mp4"),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedMedia {
    url: String,
    /// How long Ayrshare keeps it, in days: posts scheduled later than that would fail.
    keep_days: u32,
}

/// Uploads a video from this PC to Ayrshare, so posts can use its URL.
#[tauri::command]
pub async fn ayrshare_upload_video(path: String) -> Result<UploadedMedia, String> {
    let key = api_key()?;
    let file = crate::video_files::video_file(&path)?;
    let size = std::fs::metadata(&file).map_err(|_| "The video file can't be read.")?.len();
    if size == 0 || size > MAX_UPLOAD_BYTES {
        return Err("The video file is empty or too big to post.".into());
    }
    let read_path = file.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(read_path)).await
        .map_err(|_| "The video file can't be read.")?.map_err(|_| "The video file can't be read.")?;
    let (extension, mime) = content_type(&file);
    let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).filter(|name| name.contains('.')).unwrap_or_else(|| format!("video.{extension}"));
    let http = client(UPLOAD_TIMEOUT)?;
    if size <= SMALL_UPLOAD_BYTES {
        let part = reqwest::multipart::Part::bytes(bytes).file_name(name.clone()).mime_str(mime).map_err(|_| "Could not prepare the upload.")?;
        let form = reqwest::multipart::Form::new().part("file", part).text("fileName", name);
        let response = http.post(format!("{BASE}/media/upload")).bearer_auth(&key).multipart(form).send().await
            .map_err(|_| "Could not upload the video to Ayrshare. Check the internet connection.")?;
        let ok = response.status().is_success();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        let url = value.get("url").and_then(Value::as_str).filter(|_| ok)
            .ok_or_else(|| error_message(&value).map_or("Ayrshare did not take the video.".to_string(), |message| format!("Ayrshare did not take the video: {message}")))?;
        return Ok(UploadedMedia { url: url.to_owned(), keep_days: 90 });
    }
    let path = format!("media/uploadUrl?fileName={}&contentType={extension}", url::form_urlencoded::byte_serialize(name.as_bytes()).collect::<String>());
    let target = expect(&key, Call::new(reqwest::Method::GET, path), "prepare the upload").await?;
    let upload = target.get("uploadUrl").and_then(Value::as_str).ok_or("Ayrshare sent no upload address.")?;
    let access = target.get("accessUrl").and_then(Value::as_str).ok_or("Ayrshare sent no upload address.")?;
    let put_type = target.get("contentType").and_then(Value::as_str).unwrap_or(mime);
    let response = http.put(upload).header(reqwest::header::CONTENT_TYPE, put_type).body(bytes).send().await
        .map_err(|_| "Could not upload the video to Ayrshare. Check the internet connection.")?;
    if !response.status().is_success() {
        return Err("Ayrshare's storage did not take the video. Try again.".into());
    }
    Ok(UploadedMedia { url: access.to_owned(), keep_days: 30 })
}

/// Checks a post the app built: known networks only, https media, and a sane size.
pub(crate) fn check_post(body: &Value) -> Result<bool, String> {
    if !body.is_object() || body.to_string().len() > MAX_POST_BYTES {
        return Err("The post is not valid.".into());
    }
    let platforms = body.get("platforms").and_then(Value::as_array).filter(|list| !list.is_empty()).ok_or("Pick where the post goes.")?;
    if platforms.iter().any(|item| item.as_str().map_or(true, |name| !NETWORKS.contains(&name))) {
        return Err("The post names a social the app doesn't post to.".into());
    }
    if let Some(media) = body.get("mediaUrls") {
        let urls = media.as_array().ok_or("The post's video is not valid.")?;
        if urls.iter().any(|item| item.as_str().map_or(true, |url| !url.starts_with("https://"))) {
            return Err("The post's video is not valid.".into());
        }
    }
    Ok(platforms.iter().any(|item| item.as_str() == Some("twitter")))
}

/// Sends a post (with `scheduleDate` to schedule it) for the brand. Returns Ayrshare's answer as is:
/// the caller reads `status`, `id`, `postIds` and `errors` from it.
#[tauri::command]
pub async fn ayrshare_post(brand_id: String, body: Value) -> Result<Value, String> {
    let to_x = check_post(&body)?;
    if to_x && x_keys()?.is_none() {
        return Err("Posting to X through Ayrshare needs your X app's API key and secret. Add them under Settings → Posting.".into());
    }
    let profile = profile_key(&brand_id)?;
    let key = api_key()?;
    let (_, value) = send(&key, Call::new(reqwest::Method::POST, "post").profile(profile).body(body).with_x(to_x)).await?;
    if value.is_null() {
        return Err("Ayrshare did not answer. Check the brand's posts before trying again.".into());
    }
    Ok(value)
}

/// The brand's posts as Ayrshare has them (scheduled, posted and failed).
#[tauri::command]
pub async fn ayrshare_history(brand_id: String) -> Result<Value, String> {
    let profile = profile_key(&brand_id)?;
    let key = api_key()?;
    let (ok, value) = send(&key, Call::new(reqwest::Method::GET, "history?lastDays=0&limit=1000").profile(profile)).await?;
    if ok {
        return Ok(value);
    }
    // Ayrshare answers "History not found" (221) for a profile that never posted.
    if value.get("code").and_then(Value::as_i64) == Some(221) || error_message(&value).is_some_and(|message| message.contains("not found")) {
        return Ok(json!({ "history": [] }));
    }
    Err(error_message(&value).map_or("Ayrshare could not read this brand's posts.".to_string(), |message| format!("Ayrshare could not read this brand's posts: {message}")))
}

/// Cancels a scheduled post (or deletes a published one where the social allows it).
#[tauri::command]
pub async fn ayrshare_delete_post(brand_id: String, id: String) -> Result<(), String> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("That post is not valid.".into());
    }
    let profile = profile_key(&brand_id)?;
    let key = api_key()?;
    let (ok, value) = send(&key, Call::new(reqwest::Method::DELETE, "post").profile(profile).body(json!({ "id": id })).with_x(true)).await?;
    let message = error_message(&value).unwrap_or_default();
    // Already gone (deleted or never found) counts as done.
    if ok || message.contains("already") || value.get("code").and_then(Value::as_i64).is_some_and(|code| code == 383 || code == 114) {
        return Ok(());
    }
    Err(if message.is_empty() { "Ayrshare could not cancel the post.".into() } else { format!("Ayrshare could not cancel the post: {message}") })
}

/// Whether a link is a live post on one of the socials Ayrshare posts to (https only).
fn is_post_link(link: &str) -> bool {
    let Ok(url) = url::Url::parse(link) else { return false };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    url.scheme() == "https" && ["instagram.com", "facebook.com", "fb.watch", "tiktok.com", "youtube.com", "youtu.be", "x.com", "twitter.com"]
        .iter().any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// Opens a live post (its link from Ayrshare) in the default browser.
#[tauri::command]
pub async fn ayrshare_open_post(url: String) -> Result<(), String> {
    if !is_post_link(&url) { return Err("That is not a link to a post.".into()); }
    #[cfg(windows)]
    { std::process::Command::new("explorer.exe").arg(&url).spawn().map(|_| ()).map_err(|_| "Could not open your browser.".to_string()) }
    #[cfg(not(windows))]
    { Err("Open the app on Windows to view posts.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_social_post_links_open() {
        assert!(is_post_link("https://www.instagram.com/reel/abc/"));
        assert!(is_post_link("https://youtu.be/abc"));
        assert!(is_post_link("https://x.com/bunny/status/1"));
        assert!(!is_post_link("http://www.instagram.com/reel/abc/"));
        assert!(!is_post_link("https://evilinstagram.com/x"));
        assert!(!is_post_link("file:///C:/Windows/system32"));
    }

    #[test]
    fn reads_linked_socials_from_the_user_answer() {
        let user = json!({
            "activeSocialAccounts": ["tiktok", "twitter", "youtube", "linkedin"],
            "displayNames": [
                { "platform": "tiktok", "username": "bunnywhispers", "refreshRequired": "2026-12-01" },
                { "platform": "twitter", "username": "bunny_x" },
                { "platform": "youtube", "channelTitle": "Bunny Whispers", "username": "" }
            ]
        });
        let linked = linked_socials(&user);
        assert_eq!(linked, vec![
            LinkedSocial { platform: Platform::Tiktok, name: "bunnywhispers".into(), refresh: true },
            LinkedSocial { platform: Platform::X, name: "bunny_x".into(), refresh: false },
            LinkedSocial { platform: Platform::Youtube, name: "Bunny Whispers".into(), refresh: false },
        ]);
        assert!(linked_socials(&json!({})).is_empty());
    }

    #[test]
    fn checks_posts_before_sending() {
        assert_eq!(check_post(&json!({ "post": "hi", "platforms": ["tiktok"], "mediaUrls": ["https://cdn.example/v.mp4"] })), Ok(false));
        assert_eq!(check_post(&json!({ "post": "hi", "platforms": ["twitter"] })), Ok(true));
        assert!(check_post(&json!({ "post": "hi", "platforms": [] })).is_err());
        assert!(check_post(&json!({ "post": "hi", "platforms": ["linkedin"] })).is_err());
        assert!(check_post(&json!({ "post": "hi", "platforms": ["tiktok"], "mediaUrls": ["file:///C:/v.mp4"] })).is_err());
        assert!(check_post(&json!(["tiktok"])).is_err());
    }

    #[test]
    fn finds_the_error_message() {
        assert_eq!(error_message(&json!({ "status": "error", "errors": [{ "code": 156, "message": "TikTok is not linked." }] })), Some("TikTok is not linked.".into()));
        assert_eq!(error_message(&json!({ "status": "error", "posts": [{ "errors": [{ "message": "Duplicate post." }] }] })), Some("Duplicate post.".into()));
        assert_eq!(error_message(&json!({ "code": 221, "message": "History not found." })), Some("History not found.".into()));
        assert_eq!(error_message(&json!({})), None);
    }

    #[test]
    fn brand_ids_cannot_reach_other_keys() {
        assert!(profile_slot("../api-key").is_err());
        assert!(profile_slot("").is_err());
        assert_eq!(profile_slot("b-1").unwrap(), "profile-b-1");
        assert_eq!(platform_of("twitter"), Some(Platform::X));
    }
}
