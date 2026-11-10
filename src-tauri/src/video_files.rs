//! Watching library videos that live on this PC: an in-app preview, the default player, or File Explorer.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "m4v", "webm"];

/// Accepts only an existing, absolute path to a video file, so these commands can't open anything else.
fn video_file(path: &str) -> Result<PathBuf, String> {
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
    fn plain_path_drops_the_verbatim_prefix() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\Videos\a.mp4")), PathBuf::from(r"C:\Videos\a.mp4"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\a.mp4")), PathBuf::from(r"\\server\share\a.mp4"));
        assert_eq!(plain_path(Path::new(r"C:\a.mp4")), PathBuf::from(r"C:\a.mp4"));
    }
}
