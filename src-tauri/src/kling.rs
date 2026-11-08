use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::video_gen::VideoTask;

pub(crate) const API_BASE: &str = "https://api-singapore.klingai.com";
const CREATE_PATH: &str = "/text-to-video/kling-3.0-turbo";
const MAX_PROMPT_CHARS: usize = 3_072;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize)]
struct CreateVideo<'a> {
    prompt: &'a str,
    settings: VideoSettings<'a>,
}

#[derive(Serialize)]
struct VideoSettings<'a> {
    resolution: &'static str,
    aspect_ratio: &'a str,
    duration: u8,
}

#[derive(Deserialize)]
struct ApiResponse<T> {
    code: i64,
    data: Option<T>,
}

#[derive(Deserialize)]
struct ApiTask {
    id: String,
    status: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    outputs: Vec<ApiOutput>,
}

#[derive(Deserialize)]
struct ApiOutput {
    #[serde(rename = "type")]
    kind: String,
    url: Option<String>,
}

impl From<ApiTask> for VideoTask {
    fn from(task: ApiTask) -> Self {
        let video_url = task.outputs.into_iter().find_map(|output| {
            if output.kind == "video" {
                output.url.filter(|url| safe_video_url(url))
            } else {
                None
            }
        });
        Self {
            id: task.id,
            status: task.status,
            message: task.message,
            video_url,
        }
    }
}

pub(crate) fn safe_video_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let Some(url::Host::Domain(domain)) = url.host() else {
        return false;
    };
    let domain = domain.trim_end_matches('.');
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && domain.contains('.')
        && !domain.ends_with(".localhost")
        && !domain.ends_with(".local")
        && domain != "localhost"
}

pub(crate) fn validate_prompt(prompt: &str, aspect_ratio: &str, duration: u8) -> Result<(), String> {
    if prompt.trim().is_empty() || prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("Enter a prompt of up to 3,072 characters.".into());
    }
    if !matches!(aspect_ratio, "16:9" | "9:16" | "1:1") || !(3..=15).contains(&duration) {
        return Err("Choose a supported aspect ratio and a duration from 3 to 15 seconds.".into());
    }
    Ok(())
}

fn validate_task_id(task_id: &str) -> Result<(), String> {
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid Kling task ID.".into());
    }
    Ok(())
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "Could not initialize the Kling connection.".into())
}

async fn decode_response<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Kling returned HTTP {status}. Check your API key, balance, and account access."
        ));
    }
    let result: ApiResponse<T> = response
        .json()
        .await
        .map_err(|_| "Kling returned an unexpected response.")?;
    if result.code != 0 {
        return Err(format!(
            "Kling returned error code {}. Check your account and request settings.",
            result.code
        ));
    }
    result
        .data
        .ok_or_else(|| "Kling returned no task data.".into())
}

/// Starts a Kling text-to-video task. The caller has already validated the prompt.
pub async fn create(key: &str, prompt: &str, aspect_ratio: &str, duration: u8) -> Result<VideoTask, String> {
    let body = CreateVideo {
        prompt: prompt.trim(),
        settings: VideoSettings {
            resolution: "720p",
            aspect_ratio,
            duration,
        },
    };
    let response = api_client()?
        .post(format!("{API_BASE}{CREATE_PATH}"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Could not reach Kling. A timed-out request may still have created a billable task; check Kling before retrying.")?;
    let task: ApiTask = decode_response(response).await?;
    Ok(task.into())
}

pub async fn fetch(key: &str, task_id: &str) -> Result<VideoTask, String> {
    validate_task_id(task_id)?;
    let response = api_client()?
        .get(format!("{API_BASE}/tasks"))
        .bearer_auth(key)
        .query(&[("task_ids", task_id)])
        .send()
        .await
        .map_err(|_| "Could not reach Kling to check this task.")?;
    let tasks: Vec<ApiTask> = decode_response(response).await?;
    let task = tasks
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or("Kling did not return this task.")?;
    Ok(task.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_has_the_documented_settings_and_validates_inputs() {
        assert!(validate_prompt("A hummingbird", "9:16", 5).is_ok());
        assert!(validate_prompt(" ", "9:16", 5).is_err());
        assert!(validate_prompt("test", "4:3", 5).is_err());
        assert!(validate_prompt("test", "16:9", 16).is_err());
        assert!(validate_prompt(&"a".repeat(3_073), "16:9", 5).is_err());
        let request = CreateVideo {
            prompt: "A hummingbird",
            settings: VideoSettings {
                resolution: "720p",
                aspect_ratio: "9:16",
                duration: 5,
            },
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({"prompt": "A hummingbird", "settings": {"resolution": "720p", "aspect_ratio": "9:16", "duration": 5}})
        );
    }

    #[test]
    fn parses_task_result_and_rejects_unsafe_video_urls() {
        let response: ApiResponse<Vec<ApiTask>> = serde_json::from_value(serde_json::json!({"code": 0, "data": [{"id":"123", "status":"succeeded", "outputs":[{"type":"video", "url":"https://cdn.example.com/video.mp4"}]}]})).unwrap();
        let task: VideoTask = response.data.unwrap().remove(0).into();
        assert_eq!(
            task.video_url.as_deref(),
            Some("https://cdn.example.com/video.mp4")
        );
        for value in [
            "http://cdn.example.com/video",
            "https://localhost/video",
            "https://localhost./video",
            "https://machine.local/video",
            "https://127.0.0.1/video",
            "https://user@cdn.example.com/video",
        ] {
            assert!(!safe_video_url(value));
        }
        assert!(validate_task_id("abc-123").is_ok());
        assert!(validate_task_id("123&task_ids=other").is_err());
    }
}
