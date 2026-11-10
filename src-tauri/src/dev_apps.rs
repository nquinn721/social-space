//! The one developer app per social that the app signs in through, set up once:
//! Meta (Instagram), X, TikTok and Google (YouTube). Each profile then connects with
//! its own Connect button. IDs and secrets stay in Windows Credential Manager; the
//! interface only ever sees which apps are set up and their public IDs.

use serde::{Deserialize, Serialize};

#[cfg(windows)]
const KEYRING_SERVICE: &str = "social-manager-developer-app";
/// Where the Meta app was saved before this module existed.
#[cfg(windows)]
const OLD_META_SERVICE: &str = "social-manager-instagram-app";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Meta,
    X,
    Tiktok,
    Google,
}
impl Provider {
    const ALL: [Provider; 4] = [Provider::Meta, Provider::X, Provider::Tiktok, Provider::Google];
    #[cfg(windows)]
    fn key(self) -> &'static str {
        match self {
            Provider::Meta => "meta",
            Provider::X => "x",
            Provider::Tiktok => "tiktok",
            Provider::Google => "google",
        }
    }
    /// X uses PKCE and needs no secret; the others need one.
    fn needs_secret(self) -> bool { self != Provider::X }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DevApp {
    pub id: String,
    #[serde(default)]
    pub secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSummary {
    provider: Provider,
    id: Option<String>,
}

#[cfg(windows)]
fn entry(provider: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, provider.key()).map_err(|_| "Windows Credential Manager is unavailable.".into())
}

#[cfg(windows)]
fn read_old_meta() -> Option<DevApp> {
    #[derive(Deserialize)]
    struct Old { app_id: String, app_secret: String }
    let value = keyring::Entry::new(OLD_META_SERVICE, "primary").ok()?.get_password().ok()?;
    let old: Old = serde_json::from_str(&value).ok()?;
    Some(DevApp { id: old.app_id, secret: old.app_secret })
}

/// The saved developer app for a social, if it is set up.
#[cfg(windows)]
pub fn get(provider: Provider) -> Result<Option<DevApp>, String> {
    match entry(provider)?.get_password() {
        Ok(value) => Ok(serde_json::from_str(&value).ok()),
        Err(keyring::Error::NoEntry) if provider == Provider::Meta => Ok(read_old_meta()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the saved developer app.".into()),
    }
}
#[cfg(not(windows))]
pub fn get(_provider: Provider) -> Result<Option<DevApp>, String> { Ok(None) }

pub fn valid(provider: Provider, id: &str, secret: &str) -> bool {
    let id_ok = !id.is_empty() && id.len() <= 200 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    let secret_ok = if provider.needs_secret() {
        (8..=200).contains(&secret.len()) && secret.bytes().all(|b| b.is_ascii_graphic())
    } else {
        secret.is_empty() || (secret.len() <= 200 && secret.bytes().all(|b| b.is_ascii_graphic()))
    };
    id_ok && secret_ok
}

/// Saves a social's developer app, once.
pub fn save(provider: Provider, id: &str, secret: &str) -> Result<(), String> {
    let (id, secret) = (id.trim(), secret.trim());
    if !valid(provider, id, secret) {
        return Err(if provider.needs_secret() { "Enter the app's ID and secret exactly as the developer site shows them." } else { "Enter the app's Client ID exactly as the developer site shows it." }.into());
    }
    #[cfg(windows)]
    {
        let value = serde_json::to_string(&DevApp { id: id.into(), secret: secret.into() }).map_err(|_| "Could not save the developer app.")?;
        entry(provider)?.set_password(&value).map_err(|_| "Could not save the developer app to Windows Credential Manager.".into())
    }
    #[cfg(not(windows))]
    Err("Developer apps are supported on Windows only.".into())
}

#[tauri::command]
pub fn developer_apps() -> Result<Vec<AppSummary>, String> {
    Provider::ALL.iter().map(|&provider| Ok(AppSummary { provider, id: get(provider)?.map(|app| app.id) })).collect()
}

#[tauri::command]
pub fn save_developer_app(provider: Provider, id: String, secret: Option<String>) -> Result<(), String> {
    save(provider, &id, secret.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn remove_developer_app(provider: Provider) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = keyring::Entry::new(OLD_META_SERVICE, "primary").and_then(|old| if provider == Provider::Meta { old.delete_credential() } else { Ok(()) });
        return match entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove the developer app.".into()),
        };
    }
    #[cfg(not(windows))]
    { let _ = provider; Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_details_are_checked_per_social() {
        assert!(valid(Provider::Meta, "1234567890", "0123456789abcdef"));
        assert!(!valid(Provider::Meta, "1234567890", ""));
        assert!(valid(Provider::X, "aBc-123_xyz", ""));
        assert!(valid(Provider::Google, "123-abc.apps.googleusercontent.com", "GOCSPX-secret12"));
        assert!(!valid(Provider::Tiktok, "has space", "secretsecret"));
    }
}
