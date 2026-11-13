//! Brand and profile pictures from Google's Gemini image model (the Gemini API key from
//! aistudio.google.com). The key lives in Windows Credential Manager, is shared with the partner's
//! app by team sync, and is never sent to the web view. Like the Grok picture maker, a change can
//! start only from a picture this app generated, never from an arbitrary photo.

use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::grok_ai::{clean_text, generated_source, image_folder, image_kind, GeneratedImage};

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
/// Used when the model list can't be read. Newer image models are picked from the list.
const FALLBACK_MODEL: &str = "gemini-2.5-flash-image";
const IMAGE_TIMEOUT: Duration = Duration::from_secs(180);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_CHARS: usize = 300;
pub const KEY_SERVICE: &str = "social-manager-ai-key";
pub const KEY_ENTRY: &str = "gemini";
pub const NO_GEMINI_KEY: &str = "Add your Gemini API key under Settings > Pictures first (get one free at aistudio.google.com).";

static MODEL: Mutex<Option<String>> = Mutex::new(None);

// ---- Key ------------------------------------------------------------------------------------------------

#[cfg(windows)]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_ENTRY).map_err(|_| "Windows Credential Manager is unavailable.".into())
}

#[cfg(windows)]
fn read_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(Some(key)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the Gemini key from Windows Credential Manager.".into()),
    }
}

#[cfg(not(windows))]
fn read_key() -> Result<Option<String>, String> {
    Ok(std::env::var("GEMINI_API_KEY").ok().filter(|key| !key.trim().is_empty()))
}

fn require_key() -> Result<String, String> {
    read_key()?.ok_or_else(|| NO_GEMINI_KEY.to_string())
}

/// A Gemini API key: printable ASCII, no spaces, sensible length.
fn valid_key(key: &str) -> bool {
    (20..=200).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic())
}

#[tauri::command]
pub fn gemini_key_status() -> Result<bool, String> {
    Ok(read_key()?.is_some())
}

/// Checks the key with Google, then saves it.
#[tauri::command]
pub async fn save_gemini_key(key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if !valid_key(&key) {
        return Err("That doesn't look like a Gemini API key. Copy it again from aistudio.google.com.".into());
    }
    list_models(&key).await?;
    #[cfg(windows)]
    {
        entry()?.set_password(&key).map_err(|_| "Could not save the key to Windows Credential Manager.".to_string())?;
        *MODEL.lock().map_err(|_| "Gemini is unavailable.")? = None;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Saving the Gemini key is supported on Windows only.".into())
}

#[tauri::command]
pub fn remove_gemini_key() -> Result<(), String> {
    #[cfg(windows)]
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the key from Windows Credential Manager.".into()),
    }
    #[cfg(not(windows))]
    Ok(())
}

// ---- API ------------------------------------------------------------------------------------------------

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "Could not start a connection to Google.".into())
}

fn unreachable(error: reqwest::Error) -> String {
    if error.is_timeout() { "Gemini took too long to answer. Try again.".into() } else { "Could not reach Google. Check your internet connection.".into() }
}

/// Turns a Gemini error reply into one readable line.
fn api_error(status: u16, body: &Value) -> String {
    let detail: String = body["error"]["message"].as_str().unwrap_or_default().chars().take(MAX_ERROR_CHARS).collect();
    let reason = body["error"]["status"].as_str().unwrap_or_default();
    if detail.contains("API key not valid") || detail.contains("API_KEY_INVALID") || status == 401 {
        return "Google rejected the Gemini key. Check it under Settings > Pictures.".into();
    }
    match (status, reason) {
        (429, _) | (_, "RESOURCE_EXHAUSTED") => "Gemini's quota for this key is used up. Image generation may need billing turned on for the key's project at aistudio.google.com.".into(),
        (403, _) | (_, "PERMISSION_DENIED") => format!("Google refused the request{}", if detail.is_empty() { ".".into() } else { format!(": {detail}") }),
        _ if !detail.is_empty() => format!("Gemini returned an error: {detail}"),
        _ => format!("Gemini returned HTTP {status}. Try again shortly."),
    }
}

async fn read(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() { Ok(body) } else { Err(api_error(status.as_u16(), &body)) }
}

async fn list_models(key: &str) -> Result<Vec<Value>, String> {
    let response = client(LIST_TIMEOUT)?
        .get(format!("{API_BASE}/models?pageSize=1000"))
        .header("x-goog-api-key", key)
        .send()
        .await
        .map_err(unreachable)?;
    let body = read(response).await?;
    Ok(body["models"].as_array().cloned().unwrap_or_default())
}

/// The best image model the key can use: a Gemini model that makes images through generateContent,
/// Flash before Pro (faster and cheaper), stable before preview, then the newest version.
fn pick_model(models: &[Value]) -> Option<String> {
    let mut found: Vec<(bool, bool, String)> = models.iter().filter_map(|model| {
        let name = model["name"].as_str()?.strip_prefix("models/")?.to_string();
        let generates = model["supportedGenerationMethods"].as_array().is_some_and(|list| list.iter().any(|m| m == "generateContent"));
        (generates && name.starts_with("gemini") && name.contains("image") && !name.contains("imagen")).then(|| (name.contains("flash"), !name.contains("preview") && !name.contains("exp"), name))
    }).collect();
    // Highest flash flag, then stable flag, then name (newer versions sort later).
    found.sort();
    found.pop().map(|(_, _, name)| name)
}

async fn model(key: &str) -> String {
    if let Some(name) = MODEL.lock().ok().and_then(|cached| cached.clone()) {
        return name;
    }
    let name = list_models(key).await.ok().and_then(|models| pick_model(&models)).unwrap_or_else(|| FALLBACK_MODEL.into());
    if let Ok(mut cached) = MODEL.lock() {
        *cached = Some(name.clone());
    }
    name
}

fn image_body(prompt: &str, aspect: &str, source: Option<(&'static str, String)>) -> Value {
    let mut parts = vec![json!({ "text": prompt })];
    if let Some((mime, data)) = source {
        parts.push(json!({ "inlineData": { "mimeType": mime, "data": data } }));
    }
    json!({
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"], "imageConfig": { "aspectRatio": aspect } },
    })
}

/// The first picture in a generateContent reply.
fn picture_in(reply: &Value) -> Result<Vec<u8>, String> {
    if let Some(reason) = reply["promptFeedback"]["blockReason"].as_str() {
        return Err(format!("Gemini held the prompt back ({reason}). Try rewording it."));
    }
    let parts = reply["candidates"][0]["content"]["parts"].as_array().cloned().unwrap_or_default();
    let encoded = parts.iter().find_map(|part| part["inlineData"]["data"].as_str().or(part["inline_data"]["data"].as_str()));
    let Some(encoded) = encoded else {
        let finish = reply["candidates"][0]["finishReason"].as_str().unwrap_or_default();
        let said = parts.iter().find_map(|part| part["text"].as_str()).map(|text| text.chars().take(MAX_ERROR_CHARS).collect::<String>());
        return Err(match (finish, said) {
            ("SAFETY" | "PROHIBITED_CONTENT" | "IMAGE_SAFETY", _) => "Gemini held this picture back for safety. Try rewording it.".into(),
            (_, Some(text)) if !text.trim().is_empty() => format!("Gemini didn't make a picture: {}", text.trim()),
            _ => "Gemini didn't return a picture. Try again or reword the prompt.".into(),
        });
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).map_err(|_| "Gemini sent a picture that could not be read.")?;
    if image_kind(&bytes).is_none() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Gemini sent a picture that could not be read.".into());
    }
    Ok(bytes)
}

async fn make_image(key: String, model: String, body: Value) -> Result<Vec<u8>, String> {
    let response = client(IMAGE_TIMEOUT)?
        .post(format!("{API_BASE}/models/{model}:generateContent"))
        .header("x-goog-api-key", key)
        .json(&body)
        .send()
        .await
        .map_err(unreachable)?;
    picture_in(&read(response).await?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeminiRequest {
    prompt: String,
    /// How many takes to make at once (1 to 4), to pick from.
    #[serde(default)]
    count: Option<usize>,
    /// "1:1" for profile pictures, "16:9" for a YouTube banner.
    #[serde(default)]
    aspect: Option<String>,
    /// An earlier generated picture to change with the prompt.
    #[serde(default)]
    source_path: Option<String>,
}

fn aspect_of(value: Option<&str>) -> Result<&'static str, String> {
    match value.unwrap_or("1:1") {
        "1:1" => Ok("1:1"),
        "16:9" => Ok("16:9"),
        _ => Err("Pictures are square or 16:9.".into()),
    }
}

/// Makes one to four pictures with Gemini at once. Takes that fail are left out; if all fail, the
/// first error is returned.
#[tauri::command]
pub async fn generate_gemini_images(app: AppHandle, request: GeminiRequest) -> Result<Vec<GeneratedImage>, String> {
    let prompt = clean_text(&request.prompt);
    if prompt.is_empty() {
        return Err("Describe the picture first.".into());
    }
    let aspect = aspect_of(request.aspect.as_deref())?;
    let count = request.count.unwrap_or(1).clamp(1, MAX_IMAGES);
    let folder = image_folder(&app)?;
    let source = match request.source_path.as_deref().filter(|path| !path.is_empty()) {
        Some(path) => {
            let bytes = std::fs::read(generated_source(&folder, path)?).map_err(|_| "Could not read that picture.")?;
            let (_, mime) = image_kind(&bytes).ok_or("Only generated pictures can be refined.")?;
            Some((mime, base64::engine::general_purpose::STANDARD.encode(&bytes)))
        }
        None => None,
    };
    let key = require_key()?;
    let model = model(&key).await;
    let body = image_body(&prompt, aspect, source);
    let tasks: Vec<_> = (0..count).map(|_| tauri::async_runtime::spawn(make_image(key.clone(), model.clone(), body.clone()))).collect();
    let mut made = Vec::new();
    let mut first_error = None;
    for task in tasks {
        match task.await.map_err(|_| "Gemini stopped unexpectedly.".to_string()).and_then(|result| result) {
            Ok(bytes) => made.push(bytes),
            Err(error) => { first_error.get_or_insert(error); }
        }
    }
    if made.is_empty() {
        return Err(first_error.unwrap_or_else(|| "Gemini didn't return a picture.".into()));
    }
    std::fs::create_dir_all(&folder).map_err(|_| "Could not create the pictures folder.")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or_default();
    made.into_iter().enumerate().map(|(index, bytes)| {
        let (extension, mime) = image_kind(&bytes).ok_or("Gemini sent a picture that could not be read.")?;
        let path = folder.join(format!("gemini-{stamp}-{index}.{extension}"));
        std::fs::write(&path, &bytes).map_err(|_| "Could not save the picture.")?;
        Ok(GeneratedImage { path: path.to_string_lossy().into_owned(), preview: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)) })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_stable_flash_image_model_and_skips_imagen_and_text_models() {
        let models = json!([
            { "name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent", "countTokens"] },
            { "name": "models/gemini-2.5-flash-image-preview", "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/gemini-3-pro-image-preview", "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/imagen-4.0-generate-001", "supportedGenerationMethods": ["predict"] },
        ]);
        assert_eq!(pick_model(models.as_array().unwrap()).as_deref(), Some("gemini-2.5-flash-image"));
        assert_eq!(pick_model(&[]), None);
    }

    #[test]
    fn reads_the_picture_or_explains_why_there_is_none() {
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        let reply = json!({ "candidates": [{ "content": { "parts": [{ "text": "Here you go" }, { "inlineData": { "mimeType": "image/png", "data": png } }] } }] });
        assert!(picture_in(&reply).unwrap().starts_with(b"\x89PNG"));
        let blocked = json!({ "promptFeedback": { "blockReason": "SAFETY" } });
        assert!(picture_in(&blocked).unwrap_err().contains("held the prompt back"));
        let refused = json!({ "candidates": [{ "finishReason": "STOP", "content": { "parts": [{ "text": "I can't make that." }] } }] });
        assert!(picture_in(&refused).unwrap_err().contains("I can't make that."));
    }

    #[test]
    fn request_body_asks_for_an_image_in_the_right_shape() {
        let body = image_body("a fox logo", "16:9", Some(("image/png", "AAAA".into())));
        assert_eq!(body["generationConfig"]["imageConfig"]["aspectRatio"], "16:9");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "a fox logo");
        assert_eq!(body["contents"][0]["parts"][1]["inlineData"]["mimeType"], "image/png");
        assert!(aspect_of(Some("4:3")).is_err());
        assert_eq!(aspect_of(None).unwrap(), "1:1");
    }

    #[test]
    fn errors_read_plainly() {
        assert!(api_error(400, &json!({ "error": { "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT" } })).contains("rejected the Gemini key"));
        assert!(api_error(429, &json!({})).contains("quota"));
        assert!(!valid_key("short"));
        assert!(valid_key("AIzaSyA-abcdefghijklmnopqrstuvwxyz012345"));
    }
}
