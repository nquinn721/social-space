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

/// Largest generated video we will download. Provider clips are a few MB; this only stops a runaway response.
const MAX_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const MAX_NAME_CHARS: usize = 80;

/// Turns a brand, category or title into a safe Windows file or folder name.
pub(crate) fn safe_name(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { ' ' } else { c })
        .collect();
    let name: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_NAME_CHARS).collect();
    let name = name.trim_end_matches(['.', ' ']).to_string();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3"];
    if name.is_empty() || reserved.contains(&name.to_ascii_uppercase().as_str()) {
        fallback.to_string()
    } else {
        name
    }
}

/// `dir/name.mp4`, or `dir/name (2).mp4` and so on when that file already exists.
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let mut path = dir.join(format!("{name}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{name} ({n}).mp4"));
        n += 1;
    }
    path
}

/// Downloads a finished video into `Videos\SocialSpace\<brand>\<category>` and returns the file path.
#[tauri::command]
pub async fn save_generated_video(
    app: AppHandle,
    sources: State<'_, SourcesLock>,
    source_id: String,
    task_id: String,
    brand: String,
    category: String,
    title: String,
) -> Result<String, String> {
    use std::io::Write;
    use tauri::Manager;
    let task = fetch(&app, &sources, &source_id, &task_id).await?;
    let url = task.video_url.ok_or("This video is not ready yet.")?;
    let dir = app
        .path()
        .video_dir()
        .map_err(|_| "Could not find your Videos folder.".to_string())?
        .join("SocialSpace")
        .join(safe_name(&brand, "Brand"))
        .join(safe_name(&category, "Category"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|_| "Could not start the download.".to_string())?;
    let mut response = client.get(&url).send().await.map_err(|_| "Could not download the video. Try again.".to_string())?;
    if !response.status().is_success() {
        return Err(format!("The provider returned HTTP {} for the video file. The link may have expired.", response.status()));
    }
    let path = unique_path(&dir, &safe_name(&title, "AI video"));
    let partial = path.with_extension("mp4.part");
    let result: Result<(), String> = async {
        let mut file = std::fs::File::create(&partial).map_err(|e| format!("Could not save the video: {e}"))?;
        let mut written: u64 = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| "The download was interrupted. Try again.".to_string())? {
            written += chunk.len() as u64;
            if written > MAX_DOWNLOAD_BYTES {
                return Err("The video file is too large to save.".into());
            }
            file.write_all(&chunk).map_err(|e| format!("Could not save the video: {e}"))?;
        }
        if written == 0 {
            return Err("The provider sent an empty video file.".into());
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    std::fs::rename(&partial, &path).map_err(|e| format!("Could not save the video: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_strips_path_characters_and_reserved_names() {
        assert_eq!(safe_name("Silly/Rabbit: \"ep 1\"?", "x"), "Silly Rabbit ep 1");
        assert_eq!(safe_name("  ..  ", "Fallback"), "Fallback");
        assert_eq!(safe_name("con", "Fallback"), "Fallback");
        assert_eq!(safe_name("trailing dots...", "x"), "trailing dots");
        assert_eq!(safe_name(&"a".repeat(200), "x").len(), MAX_NAME_CHARS);
    }

    #[test]
    fn unique_path_numbers_existing_files() {
        let dir = std::env::temp_dir().join(format!("socialspace-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "clip");
        assert!(first.ends_with("clip.mp4"));
        std::fs::write(&first, b"x").unwrap();
        assert!(unique_path(&dir, "clip").ends_with("clip (2).mp4"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
