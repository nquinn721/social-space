//! Partner review: posts are sent to the review site (Firebase project `socialspace-review`), where a
//! reviewer signed in with Google approves or rejects them. The app works as the project's service
//! account, whose JSON key is kept in Windows Credential Manager. Videos go to the project's Storage
//! bucket with a private download link, and each post is one Firestore document, `posts/{videoId}`.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const KEYRING_SERVICE: &str = "social-manager-partner-review";
const KEYRING_ENTRY: &str = "service-account";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.read_write";
/// Tokens last an hour; one is renewed this long before it runs out.
const TOKEN_MARGIN_SECS: u64 = 300;
const TOKEN_LIFETIME_SECS: u64 = 3600;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(900);
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const VIDEO_EXTENSIONS: [(&str, &str); 4] = [("mp4", "video/mp4"), ("mov", "video/quicktime"), ("m4v", "video/x-m4v"), ("webm", "video/webm")];
/// Where reviewers open the review site.
pub const REVIEW_SITE: &str = "https://socialspace-review.web.app";

#[derive(Deserialize, Serialize, Clone)]
pub(crate) struct ServiceAccount {
    #[serde(rename = "type")]
    kind: String,
    pub(crate) project_id: String,
    private_key: String,
    client_email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewConnection {
    client_email: String,
    pub(crate) project_id: String,
    site: String,
}

/// One post as the app sends it for review.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSubmission {
    video_id: String,
    title: String,
    brand: String,
    category: String,
    youtube_title: String,
    description: String,
    hashtags: Vec<String>,
    platforms: Vec<String>,
    made_with_ai: bool,
    cover_ms: Option<u64>,
    media_source: String,
}

static TOKEN: Mutex<Option<(String, u64, String)>> = Mutex::new(None);

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ENTRY).map_err(|_| "Windows Credential Manager is unavailable.".into())
}

fn parse_key(text: &str) -> Result<ServiceAccount, String> {
    let key: ServiceAccount = serde_json::from_str(text).map_err(|_| "That file isn't a Google service account key (JSON).".to_string())?;
    if key.kind != "service_account" || key.private_key.trim().is_empty() || key.client_email.trim().is_empty() {
        return Err("That file isn't a Google service account key.".into());
    }
    Ok(key)
}

fn load_key() -> Result<Option<ServiceAccount>, String> {
    match entry()?.get_secret() {
        Ok(bytes) => parse_key(&String::from_utf8_lossy(&bytes)).map(Some),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Couldn't read the review key from Windows Credential Manager.".into()),
    }
}

/// Saved as UTF-8 bytes: Credential Manager holds at most 2560 bytes, and a key stored as a
/// password is UTF-16, twice its size, which is too long.
fn save_key(key: &ServiceAccount) -> Result<(), String> {
    let text = serde_json::to_string(key).map_err(|e| e.to_string())?;
    entry()?.set_secret(text.as_bytes()).map_err(|_| "Couldn't save the key in Windows Credential Manager.".to_string())
}

pub(crate) fn require_key() -> Result<ServiceAccount, String> {
    load_key()?.ok_or_else(|| "Partner review isn't connected. Connect it under Settings first.".into())
}

fn connection_of(key: &ServiceAccount) -> ReviewConnection {
    ReviewConnection { client_email: key.client_email.clone(), project_id: key.project_id.clone(), site: REVIEW_SITE.into() }
}

fn bucket(key: &ServiceAccount) -> String {
    format!("{}.firebasestorage.app", key.project_id)
}

pub(crate) fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(timeout).build().map_err(|e| format!("Couldn't start a web request: {e}"))
}

/// A Google access token for the service account (JWT bearer grant), reused until near its end.
pub(crate) async fn access_token(key: &ServiceAccount) -> Result<String, String> {
    if let Some((token, expires, email)) = TOKEN.lock().map_err(|_| "Token cache is unavailable.")?.clone() {
        if email == key.client_email && expires > now_secs() + TOKEN_MARGIN_SECS {
            return Ok(token);
        }
    }
    let issued = now_secs();
    let claims = json!({ "iss": key.client_email, "scope": SCOPES, "aud": TOKEN_URL, "iat": issued, "exp": issued + TOKEN_LIFETIME_SECS });
    let signing = jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes()).map_err(|_| "The review key's private key is unreadable.".to_string())?;
    let assertion = jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256), &claims, &signing)
        .map_err(|_| "Couldn't sign in with the review key.".to_string())?;
    let response = client(REQUEST_TIMEOUT)?
        .post(TOKEN_URL)
        .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", assertion.as_str())])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Google: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let token = body["access_token"].as_str().filter(|_| status.is_success()).ok_or_else(|| {
        format!("Google refused the review key: {}", body["error_description"].as_str().or(body["error"].as_str()).unwrap_or("unknown error"))
    })?;
    let expires = issued + body["expires_in"].as_u64().unwrap_or(TOKEN_LIFETIME_SECS);
    *TOKEN.lock().map_err(|_| "Token cache is unavailable.")? = Some((token.to_string(), expires, key.client_email.clone()));
    Ok(token.to_string())
}

// ---- Firestore values ------------------------------------------------------------------------------

/// Plain JSON to a Firestore typed value.
pub fn to_firestore(value: &Value) -> Value {
    match value {
        Value::Null => json!({ "nullValue": null }),
        Value::Bool(b) => json!({ "booleanValue": b }),
        Value::Number(n) if n.is_i64() || n.is_u64() => json!({ "integerValue": n.to_string() }),
        Value::Number(n) => json!({ "doubleValue": n.as_f64() }),
        Value::String(s) => json!({ "stringValue": s }),
        Value::Array(items) => json!({ "arrayValue": { "values": items.iter().map(to_firestore).collect::<Vec<_>>() } }),
        Value::Object(map) => json!({ "mapValue": { "fields": fields_of(map) } }),
    }
}
pub(crate) fn fields_of(map: &Map<String, Value>) -> Map<String, Value> {
    map.iter().map(|(k, v)| (k.clone(), to_firestore(v))).collect()
}

/// A Firestore typed value back to plain JSON.
pub fn from_firestore(value: &Value) -> Value {
    let Some((kind, inner)) = value.as_object().and_then(|map| map.iter().next()) else { return Value::Null };
    match kind.as_str() {
        "booleanValue" => inner.clone(),
        "integerValue" => inner.as_str().and_then(|s| s.parse::<i64>().ok()).map(Value::from).unwrap_or(Value::Null),
        "doubleValue" => inner.clone(),
        "stringValue" | "timestampValue" | "referenceValue" => inner.clone(),
        "arrayValue" => Value::Array(inner["values"].as_array().map(|items| items.iter().map(from_firestore).collect()).unwrap_or_default()),
        "mapValue" => Value::Object(plain_fields(&inner["fields"])),
        _ => Value::Null,
    }
}
pub(crate) fn plain_fields(fields: &Value) -> Map<String, Value> {
    fields.as_object().map(|map| map.iter().map(|(k, v)| (k.clone(), from_firestore(v))).collect()).unwrap_or_default()
}

pub(crate) fn documents_url(key: &ServiceAccount) -> String {
    format!("https://firestore.googleapis.com/v1/projects/{}/databases/(default)/documents", key.project_id)
}

/// Only ids made of letters, digits, `-` and `_`, so a document path can't be steered elsewhere.
pub(crate) fn safe_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("That post id isn't valid.".into());
    }
    Ok(id)
}

/// Lower-cased, and only something shaped like an email address.
pub fn normalize_email(email: &str) -> Result<String, String> {
    let email = email.trim().to_lowercase();
    let valid = email.len() <= 254
        && email.split_once('@').is_some_and(|(user, domain)| !user.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'))
        && !email.chars().any(|c| c.is_whitespace() || c == '/');
    if valid { Ok(email) } else { Err("That isn't an email address.".into()) }
}

async fn firestore(key: &ServiceAccount, method: reqwest::Method, url: String, body: Option<Value>) -> Result<Value, String> {
    let token = access_token(key).await?;
    let mut request = client(REQUEST_TIMEOUT)?.request(method, &url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| format!("Couldn't reach the review site: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(Value::Null);
    }
    if !status.is_success() {
        return Err(format!("The review site refused the request: {}", body["error"]["message"].as_str().unwrap_or(status.as_str())));
    }
    Ok(body)
}

async fn get_post(key: &ServiceAccount, id: &str) -> Result<Option<Map<String, Value>>, String> {
    let body = firestore(key, reqwest::Method::GET, format!("{}/posts/{id}", documents_url(key)), None).await?;
    Ok(if body.is_null() { None } else { Some(plain_fields(&body["fields"])) })
}

// ---- Commands ----------------------------------------------------------------------------------------

#[tauri::command]
pub fn review_connection() -> Result<Option<ReviewConnection>, String> {
    Ok(load_key()?.as_ref().map(connection_of))
}

/// Asks for the service account's JSON key file, checks it with Google, and keeps it in Credential Manager.
#[tauri::command]
pub async fn connect_review() -> Result<Option<ReviewConnection>, String> {
    let Some(path) = rfd::AsyncFileDialog::new().set_title("Choose the review key (JSON)").add_filter("Service account key", &["json"]).pick_file().await else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(path.path()).map_err(|_| "Couldn't read that file.".to_string())?;
    let key = parse_key(&text)?;
    access_token(&key).await?;
    save_key(&key)?;
    Ok(Some(connection_of(&key)))
}

/// Saves the review key to a file the user picks, so the partner's app can connect with it.
/// Returns the file name, or None if the dialog was closed.
#[tauri::command]
pub async fn export_review_key() -> Result<Option<String>, String> {
    let key = require_key()?;
    let text = serde_json::to_string_pretty(&key).map_err(|e| e.to_string())?;
    let Some(file) = rfd::AsyncFileDialog::new().set_title("Save the review key for your partner").set_file_name("socialspace-review-key.json").add_filter("Service account key", &["json"]).save_file().await else {
        return Ok(None);
    };
    std::fs::write(file.path(), text).map_err(|_| "Couldn't save the key file.".to_string())?;
    Ok(Some(file.file_name()))
}

#[tauri::command]
pub fn disconnect_review() -> Result<(), String> {
    *TOKEN.lock().map_err(|_| "Token cache is unavailable.")? = None;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Couldn't remove the key from Windows Credential Manager.".into()),
    }
}

#[tauri::command]
pub async fn list_reviewers() -> Result<Vec<String>, String> {
    let key = require_key()?;
    let body = firestore(&key, reqwest::Method::GET, format!("{}/reviewers?pageSize=100", documents_url(&key)), None).await?;
    let mut emails: Vec<String> = body["documents"].as_array().map(|docs| docs.iter().filter_map(|doc| doc["name"].as_str()?.rsplit('/').next().map(String::from)).collect()).unwrap_or_default();
    emails.sort();
    Ok(emails)
}

#[tauri::command]
pub async fn add_reviewer(email: String) -> Result<(), String> {
    let key = require_key()?;
    let email = normalize_email(&email)?;
    let fields = json!({ "addedAt": now_ms() });
    let body = json!({ "fields": fields_of(fields.as_object().unwrap()) });
    firestore(&key, reqwest::Method::PATCH, format!("{}/reviewers/{}", documents_url(&key), urlencoding(&email)), Some(body)).await?;
    Ok(())
}

#[tauri::command]
pub async fn remove_reviewer(email: String) -> Result<(), String> {
    let key = require_key()?;
    let email = normalize_email(&email)?;
    firestore(&key, reqwest::Method::DELETE, format!("{}/reviewers/{}", documents_url(&key), urlencoding(&email)), None).await?;
    Ok(())
}

fn urlencoding(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// Every post on the review site, as plain JSON with its id.
#[tauri::command]
pub async fn list_review_posts() -> Result<Vec<Value>, String> {
    let key = require_key()?;
    let mut posts = Vec::new();
    let mut page_token = String::new();
    loop {
        let mut url = format!("{}/posts?pageSize=300", documents_url(&key));
        if !page_token.is_empty() {
            url.push_str(&format!("&pageToken={}", urlencoding(&page_token)));
        }
        let body = firestore(&key, reqwest::Method::GET, url, None).await?;
        for doc in body["documents"].as_array().into_iter().flatten() {
            let mut fields = plain_fields(&doc["fields"]);
            if let Some(id) = doc["name"].as_str().and_then(|name| name.rsplit('/').next()) {
                fields.insert("id".into(), Value::from(id));
            }
            posts.push(Value::Object(fields));
        }
        match body["nextPageToken"].as_str() {
            Some(next) if !next.is_empty() => page_token = next.to_string(),
            _ => break,
        }
    }
    Ok(posts)
}

fn content_type(path: &std::path::Path) -> Result<&'static str, String> {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    VIDEO_EXTENSIONS.iter().find(|(known, _)| *known == ext).map(|(_, mime)| *mime).ok_or_else(|| "Only MP4, MOV, M4V and WebM videos can be sent for review.".into())
}

/// Uploads the video with a private download link and returns that link.
async fn upload_video(key: &ServiceAccount, video_id: &str, path: &std::path::Path) -> Result<(String, String), String> {
    let mime = content_type(path)?;
    let bytes = tokio::fs::read(path).await.map_err(|_| "The video file was moved or deleted.".to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_ascii_lowercase();
    let object = format!("media/{video_id}/{}.{ext}", now_ms());
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Couldn't make a download link.".to_string())?;
    let download_token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let metadata = json!({ "name": object, "contentType": mime, "metadata": { "firebaseStorageDownloadTokens": download_token } });
    let boundary = format!("socialspace{download_token}");
    let mut body = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let bucket = bucket(key);
    let token = access_token(key).await?;
    let response = client(UPLOAD_TIMEOUT)?
        .post(format!("https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=multipart"))
        .bearer_auth(token)
        .header("Content-Type", format!("multipart/related; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Couldn't upload the video: {e}"))?;
    if !response.status().is_success() {
        let body: Value = response.json().await.unwrap_or(Value::Null);
        return Err(format!("The video upload was refused: {}", body["error"]["message"].as_str().unwrap_or("unknown error")));
    }
    let url = format!("https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{}?alt=media&token={download_token}", urlencoding(&object).replace('+', "%20"));
    Ok((object, url))
}

/// Sends a post for review: uploads its video and puts it in the reviewers' queue as waiting.
/// Sending it again (after a rejection or edits) replaces the earlier version and keeps its events.
#[tauri::command]
pub async fn submit_for_review(post: ReviewSubmission) -> Result<Value, String> {
    let key = require_key()?;
    let id = safe_id(&post.video_id)?.to_string();
    let path = std::path::PathBuf::from(post.media_source.trim());
    if !path.is_absolute() || !path.is_file() {
        return Err("This video's file isn't on this PC, so it can't be sent for review.".into());
    }
    let previous = get_post(&key, &id).await?;
    if let Some(status) = previous.as_ref().and_then(|p| p.get("status")).and_then(Value::as_str) {
        if matches!(status, "approved" | "posting") {
            return Err("This post was already approved and is being posted.".into());
        }
    }
    let (media_path, media_url) = upload_video(&key, &id, &path).await?;
    let mut events = previous.as_ref().and_then(|p| p.get("events")).and_then(Value::as_array).cloned().unwrap_or_default();
    let resent = previous.is_some();
    events.push(json!({ "at": now_ms(), "text": if resent { "Sent for review again" } else { "Sent for review" } }));
    let doc = json!({
        "videoId": id, "title": post.title, "brand": post.brand, "category": post.category,
        "youtubeTitle": post.youtube_title, "description": post.description, "hashtags": post.hashtags,
        "platforms": post.platforms, "madeWithAi": post.made_with_ai, "coverMs": post.cover_ms,
        "mediaPath": media_path, "mediaUrl": media_url, "status": "pending", "submittedAt": now_ms(),
        "results": {}, "events": events,
    });
    // A PATCH without a field mask replaces the whole document, which clears an earlier decision.
    firestore(&key, reqwest::Method::PATCH, format!("{}/posts/{id}", documents_url(&key)), Some(json!({ "fields": fields_of(doc.as_object().unwrap()) }))).await?;
    if let Some(old) = previous.as_ref().and_then(|p| p.get("mediaPath")).and_then(Value::as_str) {
        delete_object(&key, old).await;
    }
    let mut saved = doc.as_object().cloned().unwrap_or_default();
    saved.insert("id".into(), Value::from(id));
    Ok(Value::Object(saved))
}

async fn delete_object(key: &ServiceAccount, object: &str) {
    if !object.starts_with("media/") {
        return;
    }
    let Ok(token) = access_token(key).await else { return };
    let Ok(client) = client(REQUEST_TIMEOUT) else { return };
    // Best effort: a leftover old upload only costs a little storage.
    let _ = client.delete(format!("https://storage.googleapis.com/storage/v1/b/{}/o/{}", bucket(key), urlencoding(object))).bearer_auth(token).send().await;
}

/// Saves how posting went: the post's status, its result on each social and its events.
#[tauri::command]
pub async fn record_review_result(video_id: String, status: String, results: Value, events: Value) -> Result<(), String> {
    let key = require_key()?;
    let id = safe_id(&video_id)?;
    if !matches!(status.as_str(), "posting" | "posted" | "partly_posted" | "failed") {
        return Err("That isn't a posting status.".into());
    }
    let mut fields = json!({ "status": status, "results": results, "events": events });
    if status != "posting" {
        fields["postedAt"] = Value::from(now_ms());
    }
    let mask: String = fields.as_object().unwrap().keys().map(|k| format!("updateMask.fieldPaths={k}")).collect::<Vec<_>>().join("&");
    let url = format!("{}/posts/{id}?{mask}&currentDocument.exists=true", documents_url(&key));
    firestore(&key, reqwest::Method::PATCH, url, Some(json!({ "fields": fields_of(fields.as_object().unwrap()) }))).await?;
    Ok(())
}

/// Takes an approved post for this PC to publish. Both apps watch the review site, so the post is
/// moved from approved to posting in one write that only succeeds if nobody changed it since it was
/// read: exactly one PC gets true and posts it.
#[tauri::command]
pub async fn claim_review_post(video_id: String) -> Result<bool, String> {
    let key = require_key()?;
    let id = safe_id(&video_id)?;
    let token = access_token(&key).await?;
    let url = format!("{}/posts/{id}", documents_url(&key));
    let response = client(REQUEST_TIMEOUT)?.get(&url).bearer_auth(&token).send().await.map_err(|e| format!("Couldn't reach the review site: {e}"))?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let doc: Value = response.json().await.unwrap_or(Value::Null);
    let status = from_firestore(&doc["fields"]["status"]);
    let Some(update_time) = doc["updateTime"].as_str().filter(|_| status == "approved") else { return Ok(false) };
    let claim = format!("{url}?updateMask.fieldPaths=status&updateMask.fieldPaths=claimedBy&currentDocument.updateTime={}", urlencoding(update_time));
    let by = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this PC".into());
    let response = client(REQUEST_TIMEOUT)?
        .patch(&claim)
        .bearer_auth(&token)
        .json(&json!({ "fields": fields_of(json!({ "status": "posting", "claimedBy": by }).as_object().unwrap()) }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the review site: {e}"))?;
    Ok(response.status().is_success())
}

/// Puts the brands and categories on the review site, so a reviewer can make a video for one of them.
#[tauri::command]
pub async fn publish_review_catalog(brands: Value) -> Result<(), String> {
    let key = require_key()?;
    if !brands.is_array() {
        return Err("The brand list isn't valid.".into());
    }
    let fields = json!({ "brands": brands, "updatedAt": now_ms() });
    let body = json!({ "fields": fields_of(fields.as_object().unwrap()) });
    firestore(&key, reqwest::Method::PATCH, format!("{}/catalog/brands", documents_url(&key)), Some(body)).await?;
    Ok(())
}

/// `dir/name.ext`, or `dir/name (2).ext` and so on when that file already exists.
fn free_path(dir: &std::path::Path, name: &str, ext: &str) -> std::path::PathBuf {
    let mut path = dir.join(format!("{name}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{name} ({n}).{ext}"));
        n += 1;
    }
    path
}

/// The file a reviewer uploaded, as a safe name and video extension, or None.
fn upload_extension(media_path: &str) -> Option<&'static str> {
    let rest = media_path.strip_prefix("uploads/")?;
    if rest.contains("..") || rest.contains('\\') {
        return None;
    }
    let ext = rest.rsplit('.').next()?.to_ascii_lowercase();
    VIDEO_EXTENSIONS.iter().map(|(known, _)| *known).find(|known| *known == ext)
}

/// Downloads a video a reviewer uploaded into `Videos\SocialSpace\<brand>\<category>` and returns its path.
#[tauri::command]
pub async fn import_review_video(app: tauri::AppHandle, media_path: String, brand: String, category: String, title: String) -> Result<String, String> {
    use std::io::Write;
    use tauri::Manager;
    let key = require_key()?;
    let ext = upload_extension(&media_path).ok_or("That upload isn't a video Social Space can use.")?;
    let dir = app
        .path()
        .video_dir()
        .map_err(|_| "Could not find your Videos folder.".to_string())?
        .join("SocialSpace")
        .join(crate::video_gen::safe_name(&brand, "Brand"))
        .join(crate::video_gen::safe_name(&category, "Category"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let token = access_token(&key).await?;
    let url = format!("https://storage.googleapis.com/storage/v1/b/{}/o/{}?alt=media", bucket(&key), urlencoding(&media_path));
    let mut response = client(UPLOAD_TIMEOUT)?.get(url).bearer_auth(token).send().await.map_err(|e| format!("Couldn't download the video: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The review site returned HTTP {} for the video.", response.status()));
    }
    let path = free_path(&dir, &crate::video_gen::safe_name(&title, "Video"), ext);
    let partial = path.with_extension(format!("{ext}.part"));
    let written: Result<u64, String> = async {
        let mut file = std::fs::File::create(&partial).map_err(|e| format!("Could not save the video: {e}"))?;
        let mut written = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|_| "The download was interrupted.".to_string())? {
            written += chunk.len() as u64;
            file.write_all(&chunk).map_err(|e| format!("Could not save the video: {e}"))?;
        }
        Ok(written)
    }
    .await;
    match written {
        Ok(bytes) if bytes > 0 => {
            std::fs::rename(&partial, &path).map_err(|e| format!("Could not save the video: {e}"))?;
            Ok(path.to_string_lossy().into_owned())
        }
        other => {
            let _ = std::fs::remove_file(&partial);
            Err(other.err().unwrap_or_else(|| "The uploaded video is empty.".into()))
        }
    }
}

#[tauri::command]
pub fn open_review_site(app: tauri::AppHandle) -> Result<(), String> {
    crate::browser::open_remote(&app, REVIEW_SITE, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firestore_values_round_trip() {
        let plain = json!({ "a": 1, "b": 1.5, "c": "x", "d": true, "e": null, "f": [1, "y"], "g": { "h": 2 } });
        assert_eq!(from_firestore(&to_firestore(&plain)), plain);
    }

    #[test]
    fn integers_are_sent_as_strings() {
        assert_eq!(to_firestore(&json!(1794421577306u64)), json!({ "integerValue": "1794421577306" }));
    }

    #[test]
    fn emails_are_checked_and_lowercased() {
        assert_eq!(normalize_email(" Partner@Example.COM ").unwrap(), "partner@example.com");
        assert!(normalize_email("not-an-email").is_err());
        assert!(normalize_email("a@b").is_err());
        assert!(normalize_email("a/b@c.com").is_err());
    }

    #[test]
    fn only_reviewer_video_uploads_are_imported() {
        assert_eq!(upload_extension("uploads/uid123/abc.MP4"), Some("mp4"));
        assert_eq!(upload_extension("uploads/uid123/abc.mov"), Some("mov"));
        assert_eq!(upload_extension("media/x/abc.mp4"), None);
        assert_eq!(upload_extension("uploads/../media/abc.mp4"), None);
        assert_eq!(upload_extension("uploads/uid/abc.exe"), None);
    }

    #[test]
    fn post_ids_cannot_leave_the_collection() {
        assert!(safe_id("1b2c-3d_4").is_ok());
        assert!(safe_id("../reviewers/x").is_err());
        assert!(safe_id("").is_err());
    }

    /// Against the real review site. REVIEW_KEY_FILE stores that key the way Connect does;
    /// REVIEW_ADD_EMAIL adds a reviewer; REVIEW_TEST_VIDEO sends that file as post `live-test`.
    #[tokio::test]
    #[ignore]
    async fn live_review_site() {
        if let Ok(path) = std::env::var("REVIEW_KEY_FILE") {
            let key = parse_key(&std::fs::read_to_string(path).unwrap()).unwrap();
            access_token(&key).await.unwrap();
            save_key(&key).unwrap();
        }
        if let Ok(email) = std::env::var("REVIEW_ADD_EMAIL") {
            add_reviewer(email).await.unwrap();
        }
        println!("reviewers: {:?}", list_reviewers().await.unwrap());
        if let Ok(path) = std::env::var("REVIEW_CATALOG_FILE") {
            publish_review_catalog(serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()).await.unwrap();
        }
        if let Ok(video) = std::env::var("REVIEW_TEST_VIDEO") {
            let post = ReviewSubmission {
                video_id: "live-test".into(), title: "Live test clip".into(), brand: "Test brand".into(), category: "Test".into(),
                youtube_title: "Live test clip".into(), description: "Checking the review flow.".into(), hashtags: vec!["test".into()],
                platforms: vec!["instagram".into(), "tiktok".into()], made_with_ai: false, cover_ms: Some(1000), media_source: video,
            };
            let saved = submit_for_review(post).await.unwrap();
            let url = saved["mediaUrl"].as_str().unwrap().to_string();
            let fetched = reqwest::get(&url).await.unwrap();
            assert!(fetched.status().is_success(), "download link works");
        }
        for post in list_review_posts().await.unwrap() {
            println!("post {} status={} decidedBy={}", post["id"], post["status"], post["decidedBy"]);
        }
        if std::env::var("REVIEW_RECORD").is_ok() {
            let results = json!({ "instagram": { "status": "manual", "at": now_ms() }, "tiktok": { "status": "manual", "at": now_ms() } });
            record_review_result("live-test".into(), "posted".into(), results, json!([{ "at": now_ms(), "text": "Live test recorded" }])).await.unwrap();
        }
    }

    #[test]
    fn only_service_account_keys_are_accepted() {
        assert!(parse_key(r#"{"type":"authorized_user","project_id":"p","private_key":"k","client_email":"e"}"#).is_err());
        assert!(parse_key(r#"{"type":"service_account","project_id":"p","private_key":"k","client_email":"e@p.iam.gserviceaccount.com"}"#).is_ok());
        assert!(parse_key("nope").is_err());
    }
}
