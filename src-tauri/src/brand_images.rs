//! A brand's pictures (its profile picture and YouTube banner, plus any per-social overrides), kept
//! in the app data folder under `brand-images/` and named by the SHA-256 of their bytes. The
//! workspace stores only those names, so it stays small; team sync uploads each picture once as its
//! own encrypted Firestore document and the other PC downloads the ones it lacks.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

pub const FOLDER: &str = "brand-images";
/// Pictures arrive already compressed by the app; this keeps each one inside a Firestore document.
pub const MAX_STORED_BYTES: usize = 600 * 1024;

/// `<64 hex>.jpg` or `.png`.
pub fn valid_name(name: &str) -> bool {
    let Some((stem, extension)) = name.split_once('.') else { return false };
    stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) && matches!(extension, "jpg" | "png")
}

/// Every picture name a shared workspace refers to.
pub fn refs_in(workspace: &Value) -> BTreeSet<String> {
    let brands = workspace["brands"].as_array().into_iter().flatten().flat_map(|brand| [&brand["image"]["file"], &brand["image"]["banner"]]);
    let accounts = workspace["accounts"].as_array().into_iter().flatten().map(|account| &account["imageFile"]);
    brands.chain(accounts).filter_map(Value::as_str).filter(|name| valid_name(name)).map(String::from).collect()
}

pub fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join(FOLDER)
}

fn kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") { Some("png") } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { Some("jpg") } else { None }
}

pub fn name_of(bytes: &[u8]) -> Option<String> {
    let hex: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    kind(bytes).map(|extension| format!("{hex}.{extension}"))
}

/// Saves a picture under its content name and returns that name. Saving the same picture twice is a no-op.
pub fn save_bytes(data_dir: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_STORED_BYTES {
        return Err("That picture is too large to share. Try again; the app compresses it first.".into());
    }
    let name = name_of(bytes).ok_or("Only JPG and PNG pictures can be saved.")?;
    let dir = folder(data_dir);
    let path = dir.join(&name);
    if !path.exists() {
        std::fs::create_dir_all(&dir).map_err(|_| "Could not create the brand pictures folder.")?;
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path)).map_err(|_| "Could not save the picture.")?;
    }
    Ok(name)
}

/// Reads a stored picture, checking it still matches its name.
pub fn read(data_dir: &Path, name: &str) -> Option<Vec<u8>> {
    if !valid_name(name) {
        return None;
    }
    let bytes = std::fs::read(folder(data_dir).join(name)).ok()?;
    (name_of(&bytes).as_deref() == Some(name)).then_some(bytes)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|_| "Could not locate the app data folder.".into())
}

fn stored_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err("That isn't a brand picture.".into());
    }
    let path = folder(&data_dir(app)?).join(name);
    if !path.exists() {
        return Err("This picture hasn't arrived on this PC yet. It comes with the next team sync.".into());
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    file: String,
    path: String,
}

/// Saves a picture the app prepared (a JPG or PNG data URL) with the brand pictures.
#[tauri::command]
pub fn save_brand_image(app: AppHandle, data_url: String) -> Result<SavedImage, String> {
    let encoded = data_url.split_once(";base64,").map(|(_, data)| data).ok_or("That picture couldn't be read.")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).map_err(|_| "That picture couldn't be read.")?;
    let dir = data_dir(&app)?;
    let file = save_bytes(&dir, &bytes)?;
    Ok(SavedImage { path: folder(&dir).join(&file).to_string_lossy().into_owned(), file })
}

/// Where a brand picture is on this PC, for filling a profile page or previewing it.
#[tauri::command]
pub fn brand_image_path(app: AppHandle, file: String) -> Result<String, String> {
    stored_path(&app, &file).map(|path| path.to_string_lossy().into_owned())
}

/// Selects a brand picture in File Explorer, e.g. to upload a banner by hand.
#[tauri::command]
pub fn reveal_brand_image(app: AppHandle, file: String) -> Result<(), String> {
    let path = stored_path(&app, &file)?;
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not open File Explorer.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];

    #[test]
    fn names_are_content_hashes_of_jpg_or_png() {
        let name = name_of(JPG).unwrap();
        assert!(valid_name(&name) && name.ends_with(".jpg"));
        assert!(name_of(b"<html>").is_none());
        assert!(!valid_name("../evil.jpg"));
        assert!(!valid_name(&format!("{}.exe", "a".repeat(64))));
        assert!(!valid_name(&format!("{}.jpg", "A".repeat(64))));
    }

    #[test]
    fn workspace_refs_cover_brand_pictures_banners_and_overrides() {
        let a = name_of(JPG).unwrap();
        let b = name_of(&[0xFF, 0xD8, 0xFF, 9]).unwrap();
        let c = name_of(b"\x89PNG..").unwrap();
        let workspace = json!({ "brands": [{ "id": "b1", "image": { "file": a, "banner": b } }, { "id": "b2" }], "accounts": [{ "id": "a1", "imageFile": c }, { "id": "a2", "imageFile": "C:\\nope.jpg" }] });
        assert_eq!(refs_in(&workspace), [a, b, c].into_iter().collect());
        assert!(refs_in(&json!({})).is_empty());
    }

    #[test]
    fn saving_is_idempotent_and_reading_checks_the_content() {
        let dir = tempfile::tempdir().unwrap();
        let name = save_bytes(dir.path(), JPG).unwrap();
        assert_eq!(save_bytes(dir.path(), JPG).unwrap(), name);
        assert_eq!(read(dir.path(), &name).as_deref(), Some(JPG));
        std::fs::write(folder(dir.path()).join(&name), b"tampered").unwrap();
        assert!(read(dir.path(), &name).is_none());
        assert!(save_bytes(dir.path(), &vec![0xFF; MAX_STORED_BYTES + 1]).is_err());
    }
}
