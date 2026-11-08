//! Provider-neutral video generation. Every request goes to a video source:
//! the one named, or the active source chosen under Video sources.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::video_sources::{SourcesLock, VideoProvider};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTask {
    pub(crate) id: String,
    pub(crate) status: String,
    pub(crate) message: Option<String>,
    pub(crate) video_url: Option<String>,
}

/// A started generation, with the source that owns it so status checks use the same key.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedVideo {
    source_id: String,
    source_name: String,
    provider: VideoProvider,
    #[serde(flatten)]
    task: VideoTask,
}

#[derive(Default)]
pub struct GenerateLock(AtomicBool);

struct GenerateGuard<'a>(&'a AtomicBool);

impl<'a> GenerateGuard<'a> {
    fn acquire(lock: &'a GenerateLock) -> Result<Self, String> {
        lock.0
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "A video generation is already being submitted.".to_string())?;
        Ok(Self(&lock.0))
    }
}

impl Drop for GenerateGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn generate_video(
    app: AppHandle,
    lock: State<'_, GenerateLock>,
    sources: State<'_, SourcesLock>,
    source_id: Option<String>,
    prompt: String,
    aspect_ratio: String,
    duration: u8,
) -> Result<StartedVideo, String> {
    let _guard = GenerateGuard::acquire(&lock)?;
    crate::kling::validate_prompt(&prompt, &aspect_ratio, duration)?;
    let source = crate::video_sources::resolve(&app, &sources, source_id.as_deref())?;
    let key = crate::video_sources::read_source_key(&source.id)?;
    let task = match source.provider {
        VideoProvider::Kling => crate::kling::create(&key, &prompt, &aspect_ratio, duration).await?,
        VideoProvider::Grok => crate::grok::create(&key, &prompt, &aspect_ratio, duration).await?,
    };
    Ok(StartedVideo { source_id: source.id, source_name: source.name, provider: source.provider, task })
}

async fn fetch(app: &AppHandle, sources: &SourcesLock, source_id: &str, task_id: &str) -> Result<VideoTask, String> {
    let source = crate::video_sources::resolve(app, sources, Some(source_id))?;
    let key = crate::video_sources::read_source_key(&source.id)?;
    match source.provider {
        VideoProvider::Kling => crate::kling::fetch(&key, task_id).await,
        VideoProvider::Grok => crate::grok::fetch(&key, task_id).await,
    }
}

#[tauri::command]
pub async fn get_video(app: AppHandle, sources: State<'_, SourcesLock>, source_id: String, task_id: String) -> Result<VideoTask, String> {
    fetch(&app, &sources, &source_id, &task_id).await
}

#[tauri::command]
pub async fn open_video(app: AppHandle, sources: State<'_, SourcesLock>, source_id: String, task_id: String) -> Result<(), String> {
    let task = fetch(&app, &sources, &source_id, &task_id).await?;
    let url = task.video_url.ok_or("No video is available for this request yet.")?;
    crate::browser::open_remote(&app, &url, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_guard_rejects_duplicate_and_releases_on_drop() {
        let lock = GenerateLock::default();
        let guard = GenerateGuard::acquire(&lock).unwrap();
        assert!(GenerateGuard::acquire(&lock).is_err());
        drop(guard);
        assert!(GenerateGuard::acquire(&lock).is_ok());
    }

    #[test]
    fn started_video_is_flat_camel_case() {
        let started = StartedVideo {
            source_id: "ab".into(),
            source_name: "Main".into(),
            provider: VideoProvider::Grok,
            task: VideoTask { id: "r1".into(), status: "pending".into(), message: None, video_url: None },
        };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            serde_json::json!({"sourceId": "ab", "sourceName": "Main", "provider": "grok", "id": "r1", "status": "pending", "message": null, "videoUrl": null})
        );
    }
}
