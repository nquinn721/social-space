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

pub(crate) fn key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, iterations, &mut key);
    key
}

pub(crate) fn random<const N: usize>() -> Result<[u8; N], String> {
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

/// Asks where to save, then writes every sign-in as plain, readable JSON: each brand's profiles with
/// username, email and password, the developer accounts with their app keys, and the video source API
/// keys. Unlike the backup it is NOT encrypted; the app warns before saving. Returns the file name, or
/// None if the dialog was closed.
#[tauri::command]
pub async fn export_accounts_json(app: AppHandle, lock: State<'_, StorageLock>, sources: State<'_, crate::video_sources::SourcesLock>) -> Result<Option<String>, String> {
    let workspace = {
        let _guard = lock.0.lock().map_err(|_| "Workspace storage is unavailable.")?;
        crate::read_workspace(&crate::workspace_path(&app)?)?
    };
    let keys = crate::video_sources::export_keys(&app, &sources)?;
    let bytes = serde_json::to_vec_pretty(&accounts_export(&workspace, account_passwords::read, connected, &keys)?).map_err(|_| "Could not write the export.")?;
    let name = format!("socialspace-accounts-{}.json", now() / 1000);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().set_title("Export accounts (plain text)").set_file_name(&name).add_filter("JSON", &["json"]).save_file() else { return Ok(None) };
        std::fs::write(&path, bytes).map_err(|_| "Could not save the export file.".to_string())?;
        Ok(path.file_name().and_then(|value| value.to_str()).map(str::to_owned))
    })
    .await
    .map_err(|_| "Could not open the save dialog.".to_string())?
}

/// Whether the profile has a social connection (API sign-in) saved on this PC.
fn connected(social: &str, account_id: &str) -> bool {
    #[cfg(windows)]
    {
        let service = match social { "instagram" => "social-manager-instagram-page", "x" => "social-manager-x-oauth", "youtube" => "social-manager-youtube", "tiktok" => "social-manager-tiktok", _ => return false };
        keyring::Entry::new(service, account_id).and_then(|entry| entry.get_secret()).is_ok()
    }
    #[cfg(not(windows))]
    { let _ = (social, account_id); false }
}

fn profile_url(social: &str, handle: &str) -> Option<String> {
    let handle = handle.trim().trim_start_matches('@');
    if handle.is_empty() { return None; }
    Some(match social {
        "instagram" => format!("https://www.instagram.com/{handle}/"),
        "x" => format!("https://x.com/{handle}"),
        "tiktok" => format!("https://www.tiktok.com/@{handle}"),
        "youtube" => format!("https://www.youtube.com/@{handle}"),
        _ => return None,
    })
}

fn accounts_export(
    workspace: &Workspace,
    password: impl Fn(&str) -> Result<Option<String>, String>,
    is_connected: impl Fn(&str, &str) -> bool,
    sources: &[(String, crate::video_sources::VideoProvider, Option<String>)],
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let social = |account: &crate::Account| serde_json::to_value(account.platform).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
    let brand_of = |account: &crate::Account| account.brand_id.as_deref().and_then(|id| workspace.brands.iter().find(|b| b.id == id)).map(|b| b.name.clone()).unwrap_or_else(|| account.label.clone());
    let channels_of = |account: &crate::Account| -> Vec<serde_json::Value> {
        workspace.channels.iter().filter(|c| c.account_id.as_deref() == Some(account.id.as_str())).map(|c| json!({ "name": c.name, "handle": c.handle })).collect()
    };
    let mut passwords = std::collections::HashMap::new();
    for account in &workspace.accounts {
        passwords.insert(account.id.clone(), password(&account.id)?);
    }
    let mut brands = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let brand_list: Vec<(Option<&str>, String)> = workspace.brands.iter().map(|b| (Some(b.id.as_str()), b.name.clone()))
        .chain(std::iter::once((None, "No brand".to_string()))).collect();
    for (id, name) in brand_list {
        let mut profiles = Vec::new();
        for account in workspace.accounts.iter().filter(|a| a.brand_id.as_deref() == id || (id.is_none() && a.brand_id.as_deref().is_none_or(|b| !workspace.brands.iter().any(|x| x.id == b)))) {
            if !seen.insert(account.id.clone()) { continue; }
            let kind = social(account);
            profiles.push(json!({
                "social": kind,
                "status": if matches!(account.status, crate::AccountStatus::Active) { "live" } else { "not created yet" },
                "username": account.handle,
                "displayName": account.display_name,
                "profileUrl": profile_url(&kind, &account.handle),
                "connected": is_connected(&kind, &account.id),
                "channels": channels_of(account),
                "email": account.signup_email,
                "password": passwords.get(&account.id).cloned().flatten(),
                "birthday": account.birthday,
            }));
        }
        if !profiles.is_empty() || id.is_some() {
            brands.push(json!({ "brand": name, "profiles": profiles }));
        }
    }
    // Each sign-in (social + email) and every profile it controls, e.g. one Google account holding
    // several YouTube channels, or up to five Instagram profiles on one login.
    let mut logins: std::collections::BTreeMap<(String, String), Vec<&crate::Account>> = Default::default();
    for account in &workspace.accounts {
        let email = account.signup_email.trim().to_lowercase();
        let key = if email.is_empty() { format!("(no email) {}", account.handle) } else { email };
        logins.entry((social(account), key)).or_default().push(account);
    }
    let logins: Vec<_> = logins.into_iter().map(|((kind, _), accounts)| {
        let password = accounts.iter().find_map(|a| passwords.get(&a.id).cloned().flatten());
        let controls: Vec<_> = accounts.iter().map(|a| json!({
            "brand": brand_of(a), "username": a.handle, "profileUrl": profile_url(&kind, &a.handle),
            "connected": is_connected(&kind, &a.id), "channels": channels_of(a),
        })).collect();
        json!({ "social": kind, "email": accounts[0].signup_email, "password": password, "controls": controls })
    }).collect();
    let mut developers = Vec::new();
    for provider in crate::dev_apps::Provider::ALL {
        let key = provider.key();
        let login = workspace.developer_logins.get(key);
        let app = crate::dev_apps::get(provider)?;
        let production = crate::dev_apps::get_production(provider)?;
        let password = password(&format!("developer-{key}"))?;
        if login.is_none() && app.is_none() && production.is_none() && password.is_none() { continue; }
        developers.push(json!({
            "provider": key,
            "email": login.map(|l| l.email.clone()),
            "password": password,
            "appId": app.as_ref().map(|a| a.id.clone()),
            "appSecret": app.as_ref().map(|a| a.secret.clone()).filter(|s| !s.is_empty()),
            "productionAppId": production.as_ref().map(|a| a.id.clone()),
            "productionAppSecret": production.as_ref().map(|a| a.secret.clone()).filter(|s| !s.is_empty()),
        }));
    }
    let api_keys: Vec<_> = sources.iter().map(|(name, provider, key)| json!({ "name": name, "provider": provider, "apiKey": key })).collect();
    Ok(json!({
        "warning": "Plain-text passwords and keys. Keep this file private and delete it when you are done.",
        "exportedAt": now(),
        "business": workspace.business_name,
        "brands": brands,
        "logins": logins,
        "developerAccounts": developers,
        "apiKeys": api_keys,
    }))
}

#[cfg(test)]
mod export_tests {
    use super::*;

    fn workspace() -> Workspace {
        serde_json::from_value(serde_json::json!({
            "businessName": "Soft Wings",
            "brands": [{ "id": "b1", "name": "Cooking" }, { "id": "b2", "name": "Animals" }],
            "accounts": [
                { "id": "y1", "platform": "youtube", "label": "Cooking", "handle": "cooking", "status": "active", "notes": "", "signupEmail": "Main@gmail.com", "brandId": "b1" },
                { "id": "y2", "platform": "youtube", "label": "Animals", "handle": "@animals", "status": "planned", "notes": "", "signupEmail": "main@gmail.com", "brandId": "b2" },
                { "id": "x1", "platform": "x", "label": "Cooking", "handle": "cook_x", "status": "active", "notes": "", "signupEmail": "main+cooking@gmail.com", "brandId": "b1" }
            ],
            "channels": [{ "id": "c1", "platform": "youtube", "name": "Cooking Shorts", "handle": "cooking", "accountId": "y1", "notes": "" }],
            "developerLogins": { "google": { "email": "dev@gmail.com" } }
        })).unwrap()
    }

    #[test]
    fn export_lists_brands_logins_and_what_each_login_controls() {
        let pw = |id: &str| Ok(match id { "y1" => Some("google-pass".to_string()), "x1" => Some("x-pass".into()), "developer-google" => Some("dev-pass".into()), _ => None });
        let out = accounts_export(&workspace(), pw, |social, id| social == "youtube" && id == "y1", &[]).unwrap();
        let cooking = &out["brands"][0];
        assert_eq!(cooking["brand"], "Cooking");
        assert_eq!(cooking["profiles"][0]["password"], "google-pass");
        assert_eq!(cooking["profiles"][0]["profileUrl"], "https://www.youtube.com/@cooking");
        assert_eq!(cooking["profiles"][0]["connected"], true);
        assert_eq!(cooking["profiles"][0]["channels"][0]["name"], "Cooking Shorts");
        let google = out["logins"].as_array().unwrap().iter().find(|l| l["social"] == "youtube").unwrap();
        assert_eq!(google["password"], "google-pass");
        let brands: Vec<_> = google["controls"].as_array().unwrap().iter().map(|c| c["brand"].as_str().unwrap()).collect();
        assert_eq!(brands, ["Cooking", "Animals"], "one Google login holds both YouTube channels");
        assert_eq!(out["logins"].as_array().unwrap().len(), 2);
        let dev = out["developerAccounts"].as_array().unwrap().iter().find(|d| d["provider"] == "google").unwrap();
        assert_eq!(dev["email"], "dev@gmail.com");
        assert_eq!(dev["password"], "dev-pass");
    }
}

#[cfg(all(test, windows))]
mod export_live {
    /// Runs the export over the installed app's real workspace and Credential Manager, printing only
    /// counts (no secrets): `cargo test export_real_workspace -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn export_real_workspace() {
        let path = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.socialmanager.desktop").join("workspace.json");
        let workspace = crate::read_workspace(&path).unwrap();
        let out = super::accounts_export(&workspace, crate::account_passwords::read, super::connected, &[]).unwrap();
        let count = |key: &str| out[key].as_array().map(Vec::len).unwrap_or(0);
        let profiles: usize = out["brands"].as_array().unwrap().iter().map(|b| b["profiles"].as_array().unwrap().len()).sum();
        let with_pw: usize = out["brands"].as_array().unwrap().iter().flat_map(|b| b["profiles"].as_array().unwrap()).filter(|p| p["password"].is_string()).count();
        let largest = out["logins"].as_array().unwrap().iter().map(|l| l["controls"].as_array().unwrap().len()).max().unwrap_or(0);
        println!("brands={} profiles={} with_password={} logins={} largest_login_controls={} developer_accounts={}", count("brands"), profiles, with_pw, count("logins"), largest, count("developerAccounts"));
        assert_eq!(profiles, workspace.accounts.len());
    }
}
