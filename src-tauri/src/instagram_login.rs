//! One-click Instagram connection through "Business Login for Instagram".
//!
//! Connect opens Instagram's own approval page in an app window, with the saved
//! username and password of the chosen profile filled in. The user presses Log in
//! and Allow themselves. Instagram then redirects to REDIRECT_URI; the window
//! catches that address (it is never loaded), and the code is swapped for a
//! long-lived token, which the existing Instagram connection stores.
//!
//! This needs one Meta app with Instagram Business Login. Its App ID and secret
//! are entered once and kept in Windows Credential Manager.

use std::{
    sync::{mpsc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// Must be listed under Valid OAuth Redirect URIs in the Meta app. It is caught in
/// the window and never actually requested.
pub const REDIRECT_URI: &str = "https://localhost/socialspace/instagram";
const AUTHORIZE_URL: &str = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL: &str = "https://api.instagram.com/oauth/access_token";
const LONG_TOKEN_URL: &str = "https://graph.instagram.com/access_token";
const SCOPES: &str = "instagram_business_basic,instagram_business_content_publish";
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
const KEYRING_SERVICE: &str = "social-manager-instagram-app";

static BUSY: Mutex<bool> = Mutex::new(false);

#[derive(Serialize, Deserialize)]
struct MetaApp {
    app_id: String,
    app_secret: String,
}

#[cfg(windows)]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, "primary").map_err(|_| "Windows Credential Manager is unavailable.".into())
}
#[cfg(windows)]
fn load_app() -> Result<Option<MetaApp>, String> {
    match entry()?.get_password() {
        Ok(value) => Ok(serde_json::from_str(&value).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the saved Meta app.".into()),
    }
}
#[cfg(not(windows))]
fn load_app() -> Result<Option<MetaApp>, String> { Ok(None) }

fn valid_app(app_id: &str, app_secret: &str) -> bool {
    !app_id.is_empty() && app_id.len() <= 32 && app_id.bytes().all(|b| b.is_ascii_digit())
        && (16..=128).contains(&app_secret.len()) && app_secret.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Whether the one-time Meta app details are saved, so Connect can be a single click.
#[tauri::command]
pub fn instagram_app_ready() -> Result<bool, String> {
    Ok(load_app()?.is_some())
}

/// Saves the Meta app's Instagram App ID and secret, once.
#[tauri::command]
pub fn save_instagram_app(app_id: String, app_secret: String) -> Result<(), String> {
    let (app_id, app_secret) = (app_id.trim(), app_secret.trim());
    if !valid_app(app_id, app_secret) {
        return Err("Enter the Instagram App ID (numbers only) and the Instagram App Secret from the Meta app.".into());
    }
    #[cfg(windows)]
    {
        let value = serde_json::to_string(&MetaApp { app_id: app_id.into(), app_secret: app_secret.into() }).map_err(|_| "Could not save the Meta app.")?;
        entry()?.set_password(&value).map_err(|_| "Could not save the Meta app to Windows Credential Manager.".into())
    }
    #[cfg(not(windows))]
    Err("Instagram connection is supported on Windows only.".into())
}

fn authorize_url(app_id: &str, state: &str) -> Result<url::Url, String> {
    url::Url::parse_with_params(AUTHORIZE_URL, &[
        ("client_id", app_id),
        ("redirect_uri", REDIRECT_URI),
        ("response_type", "code"),
        ("scope", SCOPES),
        ("state", state),
        ("force_reauth", "true"),
    ]).map_err(|_| "Could not build the Instagram approval address.".into())
}

/// Reads Instagram's redirect: the code when approved, a reason when not, or None for any other address.
fn redirect_result(url: &url::Url, state: &str) -> Option<Result<String, String>> {
    let expected = url::Url::parse(REDIRECT_URI).ok()?;
    if url.scheme() != expected.scheme() || url.host_str() != expected.host_str() || url.path() != expected.path() {
        return None;
    }
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
    let get = |name: &str| pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
    if get("state").as_deref() != Some(state) {
        return Some(Err("The Instagram approval did not match this sign-in. Press Connect again.".into()));
    }
    if get("error").is_some() {
        return Some(Err("Instagram access was not allowed.".into()));
    }
    // Instagram appends "#_" to the code.
    get("code").map(|code| code.trim_end_matches("#_").to_string()).filter(|code| !code.is_empty()).map(Ok)
        .or(Some(Err("Instagram did not return an approval code.".into())))
}

fn random_state() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Could not start a secure sign-in.")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Deserialize)]
struct ShortToken { access_token: String }
#[derive(Deserialize)]
struct LongToken { access_token: String }

async fn exchange(app: &MetaApp, code: &str) -> Result<String, String> {
    let http = reqwest::Client::builder().https_only(true).timeout(HTTP_TIMEOUT).build().map_err(|_| "Could not reach Instagram.")?;
    let response = http.post(TOKEN_URL).form(&[
        ("client_id", app.app_id.as_str()),
        ("client_secret", app.app_secret.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT_URI),
        ("code", code),
    ]).send().await.map_err(|_| "Could not reach Instagram.")?;
    if !response.status().is_success() {
        return Err(format!("Instagram did not accept the approval (HTTP {}). Check the App ID, secret and redirect address in the Meta app.", response.status().as_u16()));
    }
    let short: ShortToken = response.json().await.map_err(|_| "Instagram returned an unexpected answer.")?;
    let response = http.get(LONG_TOKEN_URL).query(&[
        ("grant_type", "ig_exchange_token"),
        ("client_secret", app.app_secret.as_str()),
        ("access_token", short.access_token.as_str()),
    ]).send().await.map_err(|_| "Could not reach Instagram.")?;
    if !response.status().is_success() {
        return Err(format!("Instagram could not extend the connection (HTTP {}).", response.status().as_u16()));
    }
    let long: LongToken = response.json().await.map_err(|_| "Instagram returned an unexpected answer.")?;
    Ok(long.access_token)
}

struct Busy;
impl Busy {
    fn take() -> Result<Self, String> {
        let mut busy = BUSY.lock().map_err(|_| "Instagram connection is unavailable.")?;
        if *busy { return Err("An Instagram approval window is already open.".into()); }
        *busy = true;
        Ok(Self)
    }
}
impl Drop for Busy {
    fn drop(&mut self) { if let Ok(mut busy) = BUSY.lock() { *busy = false; } }
}

/// One click: opens Instagram's approval page with the profile's saved username and
/// password filled in, waits for the user to press Allow, and saves the connection.
#[tauri::command]
pub async fn connect_instagram_app(app: AppHandle, account_id: Option<String>, username: Option<String>) -> Result<crate::instagram::InstagramConnection, String> {
    let _busy = Busy::take()?;
    let meta = load_app()?.ok_or("SETUP_NEEDED")?;
    let state = random_state()?;
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    let label = format!("site-instagram-{}", &state[..8]);
    let caught = sender.clone();
    let expected = state.clone();
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(authorize_url(&meta.app_id, &state)?))
        .title("Connect Instagram")
        .inner_size(520.0, 760.0)
        .on_navigation(move |url| {
            if let Some(result) = redirect_result(url, &expected) {
                let _ = caught.send(result);
                return false;
            }
            crate::browser::allowed_navigation(url, false)
        })
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                crate::autofill::page_loaded(window.as_ref());
            }
        })
        .build()
        .map_err(|_| "Could not open the Instagram window.")?;
    let closed = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            crate::autofill::window_closed(&closed);
            let _ = sender.send(Err("The Instagram window was closed before access was allowed.".into()));
        }
    });
    // Fill the saved sign-in so the user only presses Log in and Allow.
    let username = username.map(|value| value.trim().trim_start_matches('@').to_string()).filter(|value| !value.is_empty());
    if let Some(name) = &username {
        let fields = serde_json::from_value(serde_json::json!({ "username": name })).map_err(|_| "Could not prepare the sign-in.")?;
        let has_password = account_id.as_deref().map(crate::account_passwords::read).transpose()?.flatten().is_some();
        let _ = crate::autofill::fill_site_form(app.clone(), label.clone(), fields, None, account_id.clone(), Some(has_password), Some(true), None);
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(APPROVAL_TIMEOUT))
        .await
        .map_err(|_| "The Instagram approval could not finish.")?
        .map_err(|_| "The Instagram approval timed out. Press Connect again.".to_string())?;
    let _ = window.close();
    let code = outcome?;
    let token = exchange(&meta, &code).await?;
    if token.trim().is_empty() || token.chars().any(char::is_whitespace) {
        return Err("Instagram returned an invalid token.".into());
    }
    crate::instagram::store("", &token, crate::instagram::LoginKind::Instagram).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_address_carries_app_redirect_and_state() {
        let url = authorize_url("123456", "abc").unwrap();
        let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into(), v.into())).collect();
        assert!(query.contains(&("client_id".into(), "123456".into())));
        assert!(query.contains(&("redirect_uri".into(), REDIRECT_URI.into())));
        assert!(query.contains(&("state".into(), "abc".into())));
    }

    #[test]
    fn only_the_matching_redirect_is_caught() {
        let parse = |value: &str| url::Url::parse(value).unwrap();
        assert_eq!(redirect_result(&parse("https://localhost/socialspace/instagram?code=AQB1&state=abc#_"), "abc"), Some(Ok("AQB1".into())));
        assert!(redirect_result(&parse("https://localhost/socialspace/instagram?code=AQB1&state=other"), "abc").unwrap().is_err());
        assert!(redirect_result(&parse("https://localhost/socialspace/instagram?error=access_denied&state=abc"), "abc").unwrap().is_err());
        assert_eq!(redirect_result(&parse("https://www.instagram.com/accounts/login/"), "abc"), None);
    }

    #[test]
    fn meta_app_details_are_checked() {
        assert!(valid_app("1234567890", "0123456789abcdef0123456789abcdef"));
        assert!(!valid_app("12ab", "0123456789abcdef"));
        assert!(!valid_app("123", "short"));
    }
}
