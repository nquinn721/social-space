//! The assistant's chat model and the profile picture maker, both through xAI's
//! Grok API. They use the xAI key saved with a Grok video source, so the key
//! stays in Windows Credential Manager and is never sent to the web view.
//! Refining starts only from an earlier generated picture, never from an
//! arbitrary photo, so the feature cannot be pointed at a real person's face.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::grok::API_BASE;
use crate::video_sources::{xai_key, SourcesLock};

const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_MODEL_NAME: usize = 100;
const IMAGE_MODEL: &str = "grok-imagine-image-2.0";
const IMAGE_FOLDER: &str = "profile-images";
const MAX_PROMPT_CHARS: usize = 2_000;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_CHARS: usize = 300;

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|_| "Could not start a connection to xAI.".into())
}

fn unreachable(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Grok took too long to answer. Try again.".into()
    } else {
        "Could not reach xAI. Check your internet connection.".into()
    }
}

/// Turns an xAI error reply into one readable line.
fn api_error(status: u16, body: &Value) -> String {
    let detail = body["error"]["message"]
        .as_str()
        .or(body["error"].as_str())
        .or(body["message"].as_str())
        .map(|text| text.chars().take(MAX_ERROR_CHARS).collect::<String>());
    match (status, detail) {
        (401 | 403, _) => "xAI rejected the key. Check it under Settings > Video sources.".into(),
        (429, _) => "xAI is rate limiting this key or the team is out of credits.".into(),
        (_, Some(detail)) if !detail.is_empty() => format!("Grok returned an error: {detail}"),
        _ => format!("xAI returned HTTP {status}. Try again shortly."),
    }
}

async fn read(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(api_error(status.as_u16(), &body));
    }
    Ok(body)
}

/// Chat model ids, without image, video and voice models.
fn chat_models(body: &Value) -> Vec<String> {
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .or(body["models"].as_array())
        .map(|models| models.iter().filter_map(|model| model["id"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    ids.retain(|id| id.starts_with("grok") && !["imagine", "image", "video", "voice"].iter().any(|word| id.contains(word)));
    ids.sort();
    ids.dedup();
    ids
}

#[tauri::command]
pub async fn grok_models(app: AppHandle, sources: State<'_, SourcesLock>) -> Result<Vec<String>, String> {
    list_models(&xai_key(&app, &sources)?).await
}

async fn list_models(key: &str) -> Result<Vec<String>, String> {
    let response = client(MODELS_TIMEOUT)?
        .get(format!("{API_BASE}/models"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(unreachable)?;
    Ok(chat_models(&read(response).await?))
}

fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= MAX_MODEL_NAME && model.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-._:".contains(&byte))
}

/// Sends one chat turn (OpenAI-style messages and tools) and returns Grok's reply message.
#[tauri::command]
pub async fn grok_chat(app: AppHandle, sources: State<'_, SourcesLock>, model: String, messages: Value, tools: Value) -> Result<Value, String> {
    let model = model.trim();
    if !valid_model(model) {
        return Err("Choose a Grok model under Settings > Assistant.".into());
    }
    if !messages.is_array() || !(tools.is_array() || tools.is_null()) {
        return Err("Invalid chat request.".into());
    }
    chat(&xai_key(&app, &sources)?, model, messages, tools).await
}

async fn chat(key: &str, model: &str, messages: Value, tools: Value) -> Result<Value, String> {
    let mut body = json!({ "model": model, "messages": messages, "stream": false });
    if tools.as_array().is_some_and(|tools| !tools.is_empty()) {
        body["tools"] = tools;
    }
    let response = client(CHAT_TIMEOUT)?
        .post(format!("{API_BASE}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(unreachable)?;
    let reply = read(response).await?;
    reply["choices"][0]
        .get("message")
        .cloned()
        .ok_or_else(|| "Grok sent an empty reply.".into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRequest {
    prompt: String,
    /// An earlier generated picture to change with the prompt.
    source_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub(crate) path: String,
    pub(crate) preview: String,
}

pub(crate) fn image_folder(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(IMAGE_FOLDER))
        .map_err(|_| "Could not locate the app data folder.".into())
}

/// The picture format from its first bytes, as (extension, MIME type).
pub(crate) fn image_kind(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("jpg", "image/jpeg"))
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

/// Only pictures this feature made can be refined.
pub(crate) fn generated_source(folder: &Path, path: &str) -> Result<PathBuf, String> {
    let wrong = || "Only generated pictures can be refined.".to_string();
    let file = Path::new(path).canonicalize().map_err(|_| wrong())?;
    let folder = folder.canonicalize().map_err(|_| wrong())?;
    let extension = file.extension().and_then(|ext| ext.to_str()).unwrap_or_default();
    if file.parent() != Some(folder.as_path()) || !["png", "jpg", "webp"].contains(&extension) {
        return Err(wrong());
    }
    Ok(file)
}

pub(crate) fn clean_text(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() || *c == '\n').take(MAX_PROMPT_CHARS).collect::<String>().trim().to_owned()
}

fn image_body(prompt: &str, source: Option<String>) -> Value {
    let mut body = json!({ "model": IMAGE_MODEL, "prompt": prompt, "n": 1, "aspect_ratio": "1:1", "response_format": "b64_json" });
    if let Some(data_url) = source {
        body["image"] = json!({ "url": data_url, "type": "image_url" });
    }
    body
}

/// Asks Grok Imagine for one square picture, changing `source` (a data URL) when given.
async fn make_image(key: &str, prompt: &str, source: Option<String>) -> Result<Vec<u8>, String> {
    let endpoint = if source.is_some() { "images/edits" } else { "images/generations" };
    let response = client(IMAGE_TIMEOUT)?
        .post(format!("{API_BASE}/{endpoint}"))
        .bearer_auth(key)
        .json(&image_body(prompt, source))
        .send()
        .await
        .map_err(unreachable)?;
    let reply = read(response).await?;
    let encoded = reply["data"][0]["b64_json"].as_str().ok_or("Grok did not return a picture. It may have been held back by moderation; try rewording.")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).map_err(|_| "Grok sent a picture that could not be read.")?;
    if image_kind(&bytes).is_none() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Grok sent a picture that could not be read.".into());
    }
    Ok(bytes)
}

/// Makes a square profile picture with Grok Imagine, or changes an earlier one.
#[tauri::command]
pub async fn generate_profile_image(app: AppHandle, sources: State<'_, SourcesLock>, request: ImageRequest) -> Result<GeneratedImage, String> {
    let prompt = clean_text(&request.prompt);
    if prompt.is_empty() {
        return Err("Describe the picture first.".into());
    }
    let folder = image_folder(&app)?;
    let source = match request.source_path.as_deref().filter(|path| !path.is_empty()) {
        Some(path) => {
            let bytes = std::fs::read(generated_source(&folder, path)?).map_err(|_| "Could not read that picture.")?;
            let (_, mime) = image_kind(&bytes).ok_or("Only generated pictures can be refined.")?;
            Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
        }
        None => None,
    };
    let bytes = make_image(&xai_key(&app, &sources)?, &prompt, source).await?;
    let (extension, mime) = image_kind(&bytes).ok_or("Grok sent a picture that could not be read.")?;
    std::fs::create_dir_all(&folder).map_err(|_| "Could not create the pictures folder.")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or_default();
    let path = folder.join(format!("profile-{stamp}.{extension}"));
    std::fs::write(&path, &bytes).map_err(|_| "Could not save the picture.")?;
    Ok(GeneratedImage {
        path: path.to_string_lossy().into_owned(),
        preview: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_chat_models() {
        let body = json!({ "data": [{ "id": "grok-4.3" }, { "id": "grok-imagine-image-2.0" }, { "id": "grok-4.7" }, { "id": "grok-voice-3.0" }, { "id": "grok-imagine-video" }, { "id": "other" }] });
        assert_eq!(chat_models(&body), vec!["grok-4.3", "grok-4.7"]);
        assert!(chat_models(&json!({})).is_empty());
    }

    #[test]
    fn model_names_are_validated() {
        assert!(valid_model("grok-4.3"));
        assert!(valid_model("grok-4.20-0309-non-reasoning"));
        assert!(!valid_model(""));
        assert!(!valid_model("grok 4"));
        assert!(!valid_model("../models"));
        assert!(!valid_model(&"a".repeat(101)));
    }

    #[test]
    fn reads_xai_errors() {
        assert!(api_error(401, &Value::Null).contains("rejected the key"));
        assert!(api_error(429, &Value::Null).contains("rate limiting"));
        assert_eq!(api_error(400, &json!({ "error": { "message": "Model not found" } })), "Grok returned an error: Model not found");
        assert_eq!(api_error(400, &json!({ "error": "bad prompt" })), "Grok returned an error: bad prompt");
        assert_eq!(api_error(502, &Value::Null), "xAI returned HTTP 502. Try again shortly.");
    }

    #[test]
    fn recognizes_picture_formats() {
        assert_eq!(image_kind(b"\x89PNG\r\n"), Some(("png", "image/png")));
        assert_eq!(image_kind(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(("jpg", "image/jpeg")));
        assert_eq!(image_kind(b"RIFF\0\0\0\0WEBPVP8 "), Some(("webp", "image/webp")));
        assert_eq!(image_kind(b"<html>"), None);
    }

    #[test]
    fn builds_generate_and_edit_requests() {
        let plain = image_body("a cat", None);
        assert_eq!(plain["aspect_ratio"], "1:1");
        assert_eq!(plain["response_format"], "b64_json");
        assert!(plain.get("image").is_none());
        let edit = image_body("add a hat", Some("data:image/png;base64,AAAA".into()));
        assert_eq!(edit["image"]["url"], "data:image/png;base64,AAAA");
    }

    /// Calls xAI with the key saved in the installed app. Costs a few cents:
    /// `cargo test --lib grok_ai::tests::live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_grok_chats_with_tools_and_makes_and_refines_a_picture() {
        let key = crate::video_sources::installed_app_xai_key().expect("a Grok video source in the installed app");
        let models = list_models(&key).await.unwrap();
        println!("models: {models:?}");
        assert!(models.iter().any(|model| model == "grok-4.3"), "default model is available");
        let tools = json!([{ "type": "function", "function": { "name": "go_to_page", "description": "Show a page of the app.", "parameters": { "type": "object", "properties": { "page": { "type": "string", "enum": ["accounts", "settings"] } }, "required": ["page"] } } }]);
        let first = chat(&key, "grok-4.3", json!([{ "role": "user", "content": "Open the accounts page." }]), tools.clone()).await.unwrap();
        let call = first["tool_calls"][0].clone();
        assert_eq!(call["function"]["name"], "go_to_page", "{first}");
        let second = chat(&key, "grok-4.3", json!([
            { "role": "user", "content": "Open the accounts page." },
            { "role": "assistant", "content": first["content"].as_str().unwrap_or(""), "tool_calls": [call.clone()] },
            { "role": "tool", "tool_call_id": call["id"], "content": "{\"shown\":\"accounts\"}" },
        ]), tools).await.unwrap();
        println!("reply: {}", second["content"]);
        assert!(second["content"].as_str().is_some_and(|text| !text.is_empty()));
        let made = make_image(&key, LIVE_PROMPT, None).await.unwrap();
        let (_, mime) = image_kind(&made).unwrap();
        println!("made {} bytes of {mime}", made.len());
        let source = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&made));
        let refined = make_image(&key, "Keep this logo the same, but make the background deep blue.", Some(source)).await.unwrap();
        println!("refined {} bytes", refined.len());
        let out = std::env::temp_dir();
        std::fs::write(out.join("grok-live-made.img"), &made).unwrap();
        std::fs::write(out.join("grok-live-refined.img"), &refined).unwrap();
    }

    const LIVE_PROMPT: &str = "minimal modern logo mark, a pastel butterfly, flat vector style, centered on a plain background, no text";

    #[test]
    fn refining_only_accepts_generated_pictures() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join(IMAGE_FOLDER);
        std::fs::create_dir_all(&folder).unwrap();
        let made = folder.join("profile-1.jpg");
        std::fs::write(&made, [0xFF, 0xD8, 0xFF]).unwrap();
        let other = dir.path().join("face.jpg");
        std::fs::write(&other, [0xFF, 0xD8, 0xFF]).unwrap();
        let text = folder.join("notes.txt");
        std::fs::write(&text, "x").unwrap();
        assert!(generated_source(&folder, made.to_str().unwrap()).is_ok());
        assert!(generated_source(&folder, other.to_str().unwrap()).is_err());
        assert!(generated_source(&folder, text.to_str().unwrap()).is_err());
        assert!(generated_source(&folder, "missing.png").is_err());
    }
}
