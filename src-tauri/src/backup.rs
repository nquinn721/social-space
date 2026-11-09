//! Encrypted backups of every sign-in: the workspace (brands, usernames,
//! emails) plus each account's password from Windows Credential Manager.
//! The file is AES-256-GCM encrypted with a key derived from a passphrase
//! the user chooses, so it can be kept on a USB stick or in the cloud.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{AppHandle, State};

use crate::{account_passwords, StorageLock, Workspace};

const FORMAT: &str = "socialspace-sign-ins";
const VERSION: u32 = 1;
const ITERATIONS: u32 = 600_000;
const MIN_PASSPHRASE: usize = 8;
const MAX_BACKUP_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    format: String,
    version: u32,
    iterations: u32,
    salt: String,
    nonce: String,
    data: String,
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Contents {
    created_at: u64,
    workspace: Workspace,
    passwords: BTreeMap<String, String>,
}

/// What a restore found in the file: the saved workspace for the app to merge, and how many passwords came back.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    workspace: Workspace,
    passwords_restored: usize,
    created_at: u64,
}

fn key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, iterations, &mut key);
    key
}

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create a secure backup key.")?;
    Ok(bytes)
}

fn seal(contents: &Contents, passphrase: &str, iterations: u32) -> Result<Vec<u8>, String> {
    let salt = random::<16>()?;
    let nonce = random::<12>()?;
    let plain = serde_json::to_vec(contents).map_err(|_| "Could not prepare the backup.")?;
    let cipher = Aes256Gcm::new_from_slice(&key(passphrase, &salt, iterations)).map_err(|_| "Could not prepare the backup.")?;
    let data = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_ref()).map_err(|_| "Could not encrypt the backup.")?;
    let envelope = Envelope { format: FORMAT.into(), version: VERSION, iterations, salt: STANDARD.encode(salt), nonce: STANDARD.encode(nonce), data: STANDARD.encode(data) };
    serde_json::to_vec_pretty(&envelope).map_err(|_| "Could not write the backup.".into())
}

fn open(bytes: &[u8], passphrase: &str) -> Result<Contents, String> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "That file is not a Socialspace sign-in backup.")?;
    if envelope.format != FORMAT || envelope.version != VERSION || envelope.iterations == 0 {
        return Err("That file is not a Socialspace sign-in backup.".into());
    }
    let decode = |text: &str| STANDARD.decode(text).map_err(|_| "The backup file is damaged.".to_string());
    let (salt, nonce, data) = (decode(&envelope.salt)?, decode(&envelope.nonce)?, decode(&envelope.data)?);
    if nonce.len() != 12 {
        return Err("The backup file is damaged.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key(passphrase, &salt, envelope.iterations)).map_err(|_| "Could not read the backup.")?;
    let plain = cipher.decrypt(Nonce::from_slice(&nonce), data.as_ref()).map_err(|_| "Wrong passphrase, or the backup file is damaged.")?;
    serde_json::from_slice(&plain).map_err(|_| "The backup file is damaged.".into())
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis() as u64).unwrap_or(0)
}

fn check_passphrase(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < MIN_PASSPHRASE || passphrase.len() > 500 {
        return Err(format!("Use a passphrase of at least {MIN_PASSPHRASE} characters."));
    }
    Ok(())
}

/// Asks where to save, then writes an encrypted backup of the workspace and every saved password.
/// Returns the file name, or None if the user closed the dialog.
#[tauri::command]
pub async fn export_sign_ins(app: AppHandle, lock: State<'_, StorageLock>, passphrase: String) -> Result<Option<String>, String> {
    check_passphrase(&passphrase)?;
    let workspace = {
        let _guard = lock.0.lock().map_err(|_| "Workspace storage is unavailable.")?;
        crate::read_workspace(&crate::workspace_path(&app)?)?
    };
    let mut passwords = BTreeMap::new();
    for account in &workspace.accounts {
        if let Some(password) = account_passwords::read(&account.id)? {
            passwords.insert(account.id.clone(), password);
        }
    }
    let bytes = seal(&Contents { created_at: now(), workspace, passwords }, &passphrase, ITERATIONS)?;
    let name = format!("socialspace-sign-ins-{}.ssbackup", now() / 1000);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().set_title("Save sign-in backup").set_file_name(&name).add_filter("Socialspace backup", &["ssbackup"]).save_file() else { return Ok(None) };
        std::fs::write(&path, bytes).map_err(|_| "Could not save the backup file.".to_string())?;
        Ok(path.file_name().and_then(|value| value.to_str()).map(str::to_owned))
    })
    .await
    .map_err(|_| "Could not open the save dialog.".to_string())?
}

/// Asks for a backup file, decrypts it, puts its passwords back in Credential Manager,
/// and returns its workspace so the app can add back anything missing.
#[tauri::command]
pub async fn import_sign_ins(passphrase: String) -> Result<Option<Restored>, String> {
    let path = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().set_title("Choose a sign-in backup").add_filter("Socialspace backup", &["ssbackup"]).pick_file())
        .await
        .map_err(|_| "Could not open the file picker.".to_string())?;
    let Some(path) = path else { return Ok(None) };
    if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_BACKUP_BYTES {
        return Err("That file is too large to be a sign-in backup.".into());
    }
    let bytes = std::fs::read(&path).map_err(|_| "Could not read the backup file.")?;
    let contents = open(&bytes, &passphrase)?;
    let mut restored = 0;
    for (id, password) in &contents.passwords {
        if contents.workspace.accounts.iter().any(|account| &account.id == id) {
            account_passwords::set_account_password(id.clone(), password.clone())?;
            restored += 1;
        }
    }
    Ok(Some(Restored { workspace: contents.workspace, passwords_restored: restored, created_at: contents.created_at }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contents() -> Contents {
        let workspace: Workspace = serde_json::from_str(r#"{"businessName":"SoftWings","accounts":[{"id":"a","platform":"instagram","label":"Mia","handle":"softwings","status":"active","notes":"","signupEmail":"softwings25@gmail.com"}]}"#).unwrap();
        Contents { created_at: 5, workspace, passwords: BTreeMap::from([("a".to_string(), "S3cret!pass".to_string())]) }
    }

    #[test]
    fn backups_round_trip_and_hide_their_contents() {
        let sealed = seal(&contents(), "correct horse", 1_000).unwrap();
        let text = String::from_utf8(sealed.clone()).unwrap();
        assert!(!text.contains("S3cret") && !text.contains("softwings25"));
        assert_eq!(open(&sealed, "correct horse").unwrap(), contents());
    }

    #[test]
    fn a_wrong_passphrase_or_other_file_is_refused() {
        let sealed = seal(&contents(), "correct horse", 1_000).unwrap();
        assert_eq!(open(&sealed, "wrong horse").unwrap_err(), "Wrong passphrase, or the backup file is damaged.");
        assert!(open(b"{}", "correct horse").is_err());
        assert!(check_passphrase("short").is_err());
        assert!(check_passphrase("long enough").is_ok());
    }
}
