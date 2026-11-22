//! Watching library videos that live on this PC: an in-app preview, the default player, or File Explorer.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "m4v", "webm"];

/// Accepts only an existing, absolute path to a video file, so these commands can't open anything else.
pub(crate) fn video_file(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path.trim());
    let is_video = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| VIDEO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()));
    if !path.is_absolute() || !is_video {
        return Err("This isn't a video file on this PC.".into());
    }
    let path = path.canonicalize().map_err(|_| "The video file was moved or deleted.".to_string())?;
    if !path.is_file() {
        return Err("The video file was moved or deleted.".into());
    }
    Ok(plain_path(&path))
}

/// Drops the `\\?\` prefix `canonicalize` adds on Windows. The webview asks for `C:\...`, so the
/// path allowed for playback must be written the same way or the file is refused.
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text))
}

/// Lets the app window play this one file, and returns the path to load.
#[tauri::command]
pub fn preview_video_file(app: AppHandle, path: String) -> Result<String, String> {
    let path = video_file(&path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|_| "Could not open the video for playback.".to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Opens the video in the default player, or selects it in File Explorer when `reveal` is true.
#[tauri::command]
pub fn open_video_file(path: String, reveal: bool) -> Result<(), String> {
    let path = video_file(&path)?;
    let mut command = std::process::Command::new("explorer.exe");
    if reveal {
        command.arg(format!("/select,{}", path.display()));
    } else {
        command.arg(&path);
    }
    command.spawn().map(|_| ()).map_err(|_| "Could not open File Explorer.".to_string())
}

/// Largest edited video the app saves. Short social clips are a few MB; this only stops a runaway recording.
const MAX_EDITED_BYTES: usize = 1024 * 1024 * 1024;

#[derive(serde::Deserialize)]
struct EditedVideo {
    brand: String,
    category: String,
    title: String,
    ext: String,
}

/// Reads the `x-video` header: the brand, category, title and file type, as URI-encoded JSON.
fn edited_video_meta(header: Option<&str>) -> Result<EditedVideo, String> {
    let raw = header.ok_or("The video's details are missing.")?;
    let decoded = url::form_urlencoded::parse(format!("v={raw}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .ok_or("The video's details could not be read.")?;
    let meta: EditedVideo = serde_json::from_str(&decoded).map_err(|_| "The video's details could not be read.".to_string())?;
    if !matches!(meta.ext.as_str(), "mp4" | "webm") {
        return Err("Only MP4 and WebM videos can be saved.".into());
    }
    Ok(meta)
}

/// `dir/name.ext`, or `dir/name (2).ext` and so on when that file already exists.
fn unique_file(dir: &Path, name: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{name}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{name} ({n}).{ext}"));
        n += 1;
    }
    path
}

/// Saves a video recorded by the text editor into `Videos\SocialSpace\<brand>\<category>` and returns its path.
/// The body is the file's bytes; the `x-video` header names the brand, category, title and type.
#[tauri::command]
pub fn save_edited_video(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let meta = edited_video_meta(request.headers().get("x-video").and_then(|value| value.to_str().ok()))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The video arrived in the wrong form.".into());
    };
    if bytes.is_empty() {
        return Err("The recorded video is empty.".into());
    }
    if bytes.len() > MAX_EDITED_BYTES {
        return Err("The video is too large to save.".into());
    }
    let dir = app
        .path()
        .video_dir()
        .map_err(|_| "Could not find your Videos folder.".to_string())?
        .join("SocialSpace")
        .join(crate::video_gen::safe_name(&meta.brand, "Brand"))
        .join(crate::video_gen::safe_name(&meta.category, "Category"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let path = unique_file(&dir, &crate::video_gen::safe_name(&meta.title, "Video with text"), &meta.ext);
    let partial = path.with_extension(format!("{}.part", meta.ext));
    std::fs::write(&partial, bytes).map_err(|e| format!("Could not save the video: {e}"))?;
    if let Err(e) = std::fs::rename(&partial, &path) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("Could not save the video: {e}"));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Lets you pick a video file on this PC for the library.
#[tauri::command]
pub async fn choose_video_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a video")
            .add_filter("Video", &["mp4", "mov", "m4v", "webm"])
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
    fn only_existing_absolute_video_files_are_accepted() {
        let dir = std::env::temp_dir().join(format!("socialspace-video-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.MP4");
        let script = dir.join("run.bat");
        std::fs::write(&clip, b"x").unwrap();
        std::fs::write(&script, b"x").unwrap();
        let accepted = video_file(clip.to_str().unwrap()).unwrap();
        assert!(!accepted.to_string_lossy().starts_with(r"\\?\"), "{}", accepted.display());
        assert!(video_file(script.to_str().unwrap()).is_err());
        assert!(video_file("clip.mp4").is_err());
        assert!(video_file(dir.join("missing.mp4").to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn edited_video_meta_reads_encoded_json_and_only_video_types() {
        let meta = edited_video_meta(Some("%7B%22brand%22%3A%22Bunny%20%26%20Co%22%2C%22category%22%3A%22Quotes%2B%22%2C%22title%22%3A%22Hop%20%E2%9C%A8%22%2C%22ext%22%3A%22mp4%22%7D")).unwrap();
        assert_eq!(meta.brand, "Bunny & Co");
        assert_eq!(meta.category, "Quotes+");
        assert_eq!(meta.title, "Hop \u{2728}");
        assert!(edited_video_meta(Some("%7B%22brand%22%3A%22a%22%2C%22category%22%3A%22b%22%2C%22title%22%3A%22c%22%2C%22ext%22%3A%22bat%22%7D")).is_err());
        assert!(edited_video_meta(None).is_err());
    }

    #[test]
    fn unique_file_numbers_existing_names() {
        let dir = std::env::temp_dir().join(format!("socialspace-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_file(&dir, "a", "mp4"), dir.join("a.mp4"));
        std::fs::write(dir.join("a.mp4"), b"x").unwrap();
        assert_eq!(unique_file(&dir, "a", "mp4"), dir.join("a (2).mp4"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn plain_path_drops_the_verbatim_prefix() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\Videos\a.mp4")), PathBuf::from(r"C:\Videos\a.mp4"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\a.mp4")), PathBuf::from(r"\\server\share\a.mp4"));
        assert_eq!(plain_path(Path::new(r"C:\a.mp4")), PathBuf::from(r"C:\a.mp4"));
    }
}
