//! Grok Imagine video generation through the xAI API.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::video_gen::VideoTask;

pub(crate) const API_BASE: &str = "https://api.x.ai/v1";
const MODEL: &str = "grok-imagine-video";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize)]
struct CreateVideo<'a> {
    model: &'static str,
    prompt: &'a str,
    aspect_ratio: &'a str,
    duration: u8,
    resolution: &'static str,
}

#[derive(Deserialize)]
struct Created {
    request_id: String,
}

#[derive(Deserialize)]
struct ApiResult {
    status: String,
    #[serde(default)]
    progress: Option<u8>,
    #[serde(default)]
    error: Option<ApiError>,
    #[serde(default)]
    video: Option<ApiVideo>,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

#[derive(Deserialize)]
struct ApiVideo {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    respect_moderation: Option<bool>,
}

fn to_task(id: &str, result: ApiResult) -> VideoTask {
    let video = result.video;
    let blocked = video.as_ref().and_then(|video| video.respect_moderation) == Some(false);
    let video_url = video
        .and_then(|video| video.url)
        .filter(|url| crate::kling::safe_video_url(url));
    let message = if let Some(error) = result.error {
        Some(error.message.chars().take(300).collect())
    } else if blocked {
        Some("Grok held this video back for breaking its moderation rules.".into())
    } else if result.status == "pending" {
        result.progress.map(|progress| format!("{progress}% done"))
    } else {
        None
    };
    VideoTask { id: id.into(), status: result.status, message, video_url }
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("Invalid Grok request ID.".into());
    }
    Ok(())
}

pub(crate) fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "Could not start a connection to xAI.".into())
}

async fn decode<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "xAI rejected this API key. Check it under Video sources.".into(),
            429 => "xAI is rate limiting this key or the team is out of credits.".into(),
            _ => format!("xAI returned HTTP {status}. Try again shortly."),
        });
    }
    response.json().await.map_err(|_| "xAI returned an unexpected response.".into())
}

/// Starts a Grok Imagine video. The caller has already validated the prompt.
pub async fn create(key: &str, prompt: &str, aspect_ratio: &str, duration: u8) -> Result<VideoTask, String> {
    let body = CreateVideo { model: MODEL, prompt: prompt.trim(), aspect_ratio, duration, resolution: "720p" };
    let response = api_client()?
        .post(format!("{API_BASE}/videos/generations"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Could not reach xAI. A timed-out request may still have started a billable video; check before retrying.")?;
    let created: Created = decode(response).await?;
    validate_request_id(&created.request_id)?;
    Ok(VideoTask { id: created.request_id, status: "pending".into(), message: None, video_url: None })
}

pub async fn fetch(key: &str, request_id: &str) -> Result<VideoTask, String> {
    validate_request_id(request_id)?;
    let response = api_client()?
        .get(format!("{API_BASE}/videos/{request_id}"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "Could not reach xAI to check this video.")?;
    let result: ApiResult = decode(response).await?;
    Ok(to_task(request_id, result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_matches_the_documented_shape() {
        let body = CreateVideo { model: MODEL, prompt: "A lake", aspect_ratio: "9:16", duration: 8, resolution: "720p" };
        assert_eq!(
            serde_json::to_value(body).unwrap(),
            serde_json::json!({"model": "grok-imagine-video", "prompt": "A lake", "aspect_ratio": "9:16", "duration": 8, "resolution": "720p"})
        );
    }

    #[test]
    fn results_report_progress_videos_errors_and_moderation() {
        let pending: ApiResult = serde_json::from_str(r#"{"status":"pending","progress":40}"#).unwrap();
        let task = to_task("r1", pending);
        assert_eq!((task.status.as_str(), task.message.as_deref()), ("pending", Some("40% done")));

        let done: ApiResult = serde_json::from_str(r#"{"status":"done","video":{"url":"https://vidgen.x.ai/a.mp4","respect_moderation":true,"duration":8}}"#).unwrap();
        assert_eq!(to_task("r1", done).video_url.as_deref(), Some("https://vidgen.x.ai/a.mp4"));

        let unsafe_url: ApiResult = serde_json::from_str(r#"{"status":"done","video":{"url":"http://localhost/a.mp4"}}"#).unwrap();
        assert_eq!(to_task("r1", unsafe_url).video_url, None);

        let blocked: ApiResult = serde_json::from_str(r#"{"status":"done","video":{"url":null,"respect_moderation":false}}"#).unwrap();
        assert!(to_task("r1", blocked).message.unwrap().contains("moderation"));

        let failed: ApiResult = serde_json::from_str(r#"{"status":"failed","error":{"code":"internal_error","message":"Engine failed"}}"#).unwrap();
        assert_eq!(to_task("r1", failed).message.as_deref(), Some("Engine failed"));
    }

    #[test]
    fn request_ids_cannot_change_the_path() {
        assert!(validate_request_id("a3d1008e-4544-40d4-d075-11527e794e4a").is_ok());
        assert!(validate_request_id("../files").is_err());
        assert!(validate_request_id("a?b=c").is_err());
    }
}
