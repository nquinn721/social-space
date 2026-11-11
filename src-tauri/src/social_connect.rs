//! Per-profile connections to YouTube (Google sign-in) and TikTok (Login Kit).
//!
//! Connect opens the social's own approval page in an app window. The user signs in
//! and presses Allow; the redirect is caught in the window (it is never loaded), the
//! code is exchanged for tokens with the social's developer app (set up once), and
//! the connection is saved under the app profile in Windows Credential Manager.

use std::{
    sync::{mpsc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::dev_apps::{self, Provider};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const YOUTUBE_CHANNEL_URL: &str = "https://www.googleapis.com/youtube/v3/channels";
/// Google lets desktop apps use any loopback address; it is caught in the window, not served.
pub const YOUTUBE_REDIRECT_URI: &str = "http://127.0.0.1:49174/socialspace/youtube";
const YOUTUBE_SCOPES: &str = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

const TIKTOK_AUTH_URL: &str = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL: &str = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_USER_URL: &str = "https://open.tiktokapis.com/v2/user/info/";
/// Must be added as a redirect URI in the TikTok app. It is caught in the window, not served.
pub const TIKTOK_REDIRECT_URI: &str = "https://localhost/socialspace/tiktok";
const TIKTOK_SCOPES: &str = "user.info.basic,user.info.profile,video.upload";

static BUSY: Mutex<bool> = Mutex::new(false);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Social { Youtube, Tiktok }
impl Social {
    fn provider(self) -> Provider { match self { Social::Youtube => Provider::Google, Social::Tiktok => Provider::Tiktok } }
    fn name(self) -> &'static str { match self { Social::Youtube => "YouTube", Social::Tiktok => "TikTok" } }
    #[cfg(windows)]
    fn keyring_service(self) -> &'static str { match self { Social::Youtube => "social-manager-youtube", Social::Tiktok => "social-manager-tiktok" } }
    fn redirect(self) -> &'static str { match self { Social::Youtube => YOUTUBE_REDIRECT_URI, Social::Tiktok => TIKTOK_REDIRECT_URI } }
}

/// What a profile is connected as on YouTube or TikTok.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SocialConnection {
    pub id: String,
    pub username: String,
    pub name: String,
}

#[derive(Serialize, Deserialize)]
struct Credential {
    connection: SocialConnection,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

#[cfg(windows)]
fn entry(social: Social, profile: &str) -> Result<keyring::Entry, String> {
    let slot = crate::instagram::slot(Some(profile))?;
    keyring::Entry::new(social.keyring_service(), &slot).map_err(|_| "Windows Credential Manager is unavailable.".into())
}
#[cfg(windows)]
fn load(social: Social, profile: &str) -> Result<Option<Credential>, String> {
    match entry(social, profile)?.get_password() {
        Ok(value) => Ok(serde_json::from_str(&value).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(format!("Could not read the saved {} connection.", social.name())),
    }
}
#[cfg(not(windows))]
fn load(_social: Social, _profile: &str) -> Result<Option<Credential>, String> { Ok(None) }
#[cfg(windows)]
fn save(social: Social, profile: &str, credential: &Credential) -> Result<(), String> {
    let value = serde_json::to_string(credential).map_err(|_| "Could not save the connection.")?;
    entry(social, profile)?.set_password(&value).map_err(|_| "Could not save the connection to Windows Credential Manager.".into())
}
#[cfg(not(windows))]
fn save(_social: Social, _profile: &str, _credential: &Credential) -> Result<(), String> { Err("Supported on Windows only.".into()) }

fn random_text() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not start a secure sign-in.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
/// Google uses the standard PKCE challenge (base64url of SHA-256).
fn challenge_base64(verifier: &str) -> String { URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) }
/// TikTok's desktop Login Kit wants the SHA-256 as hex.
fn challenge_hex(verifier: &str) -> String { Sha256::digest(verifier.as_bytes()).iter().map(|b| format!("{b:02x}")).collect() }

fn authorize_url(social: Social, client_id: &str, state: &str, verifier: &str, hint: Option<&str>) -> Result<url::Url, String> {
    let mut url = match social {
        Social::Youtube => url::Url::parse_with_params(GOOGLE_AUTH_URL, &[
            ("client_id", client_id), ("redirect_uri", YOUTUBE_REDIRECT_URI), ("response_type", "code"),
            ("scope", YOUTUBE_SCOPES), ("access_type", "offline"), ("prompt", "consent select_account"),
            ("state", state), ("code_challenge", &challenge_base64(verifier)), ("code_challenge_method", "S256"),
        ]),
        Social::Tiktok => url::Url::parse_with_params(TIKTOK_AUTH_URL, &[
            ("client_key", client_id), ("redirect_uri", TIKTOK_REDIRECT_URI), ("response_type", "code"),
            ("scope", TIKTOK_SCOPES), ("state", state),
            ("code_challenge", &challenge_hex(verifier)), ("code_challenge_method", "S256"),
        ]),
    }.map_err(|_| "Could not build the approval address.")?;
    if let (Social::Youtube, Some(hint)) = (social, hint.filter(|value| value.contains('@'))) {
        url.query_pairs_mut().append_pair("login_hint", hint);
    }
    Ok(url)
}

/// The code from the social's redirect, a reason it failed, or None for any other address.
fn redirect_result(social: Social, url: &url::Url, state: &str) -> Option<Result<String, String>> {
    let expected = url::Url::parse(social.redirect()).ok()?;
    if url.scheme() != expected.scheme() || url.host_str() != expected.host_str() || url.port() != expected.port() || url.path() != expected.path() {
        return None;
    }
    let get = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
    if get("state").as_deref() != Some(state) {
        return Some(Err("The approval did not match this sign-in. Press Connect again.".into()));
    }
    if get("error").is_some() {
        return Some(Err(format!("{} access was not allowed.", social.name())));
    }
    Some(get("code").filter(|code| !code.is_empty()).ok_or_else(|| format!("{} did not return an approval code.", social.name())))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().https_only(true).timeout(HTTP_TIMEOUT).build().map_err(|_| "Could not reach the social.".into())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    open_id: Option<String>,
}

async fn token(social: Social, app: &dev_apps::DevApp, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let (url, id_field) = match social { Social::Youtube => (GOOGLE_TOKEN_URL, "client_id"), Social::Tiktok => (TIKTOK_TOKEN_URL, "client_key") };
    let mut fields = vec![(id_field, app.id.as_str()), ("client_secret", app.secret.as_str())];
    fields.extend_from_slice(form);
    let response = client()?.post(url).form(&fields).send().await.map_err(|_| format!("Could not reach {}.", social.name()))?;
    if !response.status().is_success() {
        return Err(format!("{} did not accept the approval (HTTP {}). Check the app's ID, secret and redirect address.", social.name(), response.status().as_u16()));
    }
    response.json().await.map_err(|_| format!("{} returned an unexpected answer.", social.name()))
}

async fn identity(social: Social, access_token: &str, open_id: Option<String>) -> Result<SocialConnection, String> {
    let http = client()?;
    match social {
        Social::Youtube => {
            #[derive(Deserialize)] struct Snippet { title: String, #[serde(default, rename = "customUrl")] custom_url: Option<String> }
            #[derive(Deserialize)] struct Item { id: String, snippet: Snippet }
            #[derive(Deserialize)] struct Channels { #[serde(default)] items: Vec<Item> }
            let response = http.get(YOUTUBE_CHANNEL_URL).query(&[("part", "snippet"), ("mine", "true")]).bearer_auth(access_token).send().await.map_err(|_| "Could not reach YouTube.")?;
            if !response.status().is_success() {
                return Err(format!("YouTube could not read the channel (HTTP {}). Is the YouTube Data API enabled in the Google project?", response.status().as_u16()));
            }
            let channels: Channels = response.json().await.map_err(|_| "YouTube returned an unexpected answer.")?;
            let item = channels.items.into_iter().next().ok_or("That Google account has no YouTube channel yet. Create the channel first, then connect.")?;
            let username = item.snippet.custom_url.unwrap_or_default().trim_start_matches('@').to_string();
            Ok(SocialConnection { id: item.id, username, name: item.snippet.title })
        }
        Social::Tiktok => {
            #[derive(Deserialize)] struct User { open_id: String, #[serde(default)] username: String, #[serde(default)] display_name: String }
            #[derive(Deserialize)] struct Data { user: User }
            #[derive(Deserialize)] struct Info { data: Data }
            let response = http.get(TIKTOK_USER_URL).query(&[("fields", "open_id,username,display_name")]).bearer_auth(access_token).send().await.map_err(|_| "Could not reach TikTok.")?;
            if !response.status().is_success() {
                return Err(format!("TikTok could not read the account (HTTP {}).", response.status().as_u16()));
            }
            let info: Info = response.json().await.map_err(|_| "TikTok returned an unexpected answer.")?;
            Ok(SocialConnection { id: open_id.unwrap_or(info.data.user.open_id), username: info.data.user.username, name: info.data.user.display_name })
        }
    }
}

struct Busy;
impl Busy {
    fn take() -> Result<Self, String> {
        let mut busy = BUSY.lock().map_err(|_| "Connecting is unavailable.")?;
        if *busy { return Err("An approval window is already open.".into()); }
        *busy = true;
        Ok(Self)
    }
}
impl Drop for Busy { fn drop(&mut self) { if let Ok(mut busy) = BUSY.lock() { *busy = false; } } }

async fn connect(app: AppHandle, social: Social, profile: String, hint: Option<String>, username: Option<String>) -> Result<SocialConnection, String> {
    let _busy = Busy::take()?;
    crate::instagram::slot(Some(&profile))?;
    let dev = dev_apps::get(social.provider())?.ok_or("SETUP_NEEDED")?;
    let state = random_text()?;
    let verifier = random_text()?;
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    let label = format!("site-{}-{}", social.name().to_lowercase(), &state[..8].to_lowercase().replace(['-', '_'], "x"));
    let caught = sender.clone();
    let expected = state.clone();
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(authorize_url(social, &dev.id, &state, &verifier, hint.as_deref())?))
        .title(format!("Connect {}", social.name()))
        .inner_size(520.0, 760.0)
        .on_navigation(move |url| {
            if let Some(result) = redirect_result(social, url, &expected) {
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
        .map_err(|_| format!("Could not open the {} window.", social.name()))?;
    let closed = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            crate::autofill::window_closed(&closed);
            let _ = sender.send(Err("The window was closed before access was allowed.".into()));
        }
    });
    // TikTok's sign-in is filled with the profile's saved username and password; the user presses the buttons.
    if let (Social::Tiktok, Some(name)) = (social, username.as_deref().map(|v| v.trim().trim_start_matches('@')).filter(|v| !v.is_empty())) {
        if let Ok(fields) = serde_json::from_value(serde_json::json!({ "username": name })) {
            let has_password = crate::account_passwords::read(&profile).ok().flatten().is_some();
            let _ = crate::autofill::fill_site_form(app.clone(), label.clone(), fields, None, Some(profile.clone()), Some(has_password), Some(true), None);
        }
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(APPROVAL_TIMEOUT))
        .await
        .map_err(|_| "The approval could not finish.")?
        .map_err(|_| "The approval timed out. Press Connect again.".to_string())?;
    let _ = window.close();
    let code = outcome?;
    let tokens = token(social, &dev, &[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", social.redirect()), ("code_verifier", &verifier)]).await?;
    let refresh_token = tokens.refresh_token.clone().ok_or_else(|| format!("{} did not allow staying connected. Press Connect again.", social.name()))?;
    let connection = identity(social, &tokens.access_token, tokens.open_id.clone()).await?;
    save(social, &profile, &Credential { connection: connection.clone(), access_token: tokens.access_token, refresh_token, expires_at: now() + tokens.expires_in.unwrap_or(3600) })?;
    Ok(connection)
}

fn connection(social: Social, profile: &str) -> Result<Option<SocialConnection>, String> {
    Ok(load(social, profile)?.map(|credential| credential.connection))
}

fn disconnect(social: Social, profile: &str) -> Result<(), String> {
    #[cfg(windows)]
    return match entry(social, profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the connection.".into()),
    };
    #[cfg(not(windows))]
    { let _ = (social, profile); Ok(()) }
}

/// How a saved connection is doing, as the setup tracker shows it.
/// state: "none" (not connected), "ok" (works and renews by itself), "expired" (the social
/// stopped accepting it: connect again), "unchecked" (the social could not be reached just now).
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCheck {
    pub state: &'static str,
    pub username: String,
    pub detail: String,
}
impl ConnectionCheck {
    pub fn none() -> Self { Self { state: "none", username: String::new(), detail: String::new() } }
    pub fn ok(username: String) -> Self { Self { state: "ok", username, detail: "Renews by itself.".into() } }
    pub fn expired(username: String, detail: String) -> Self { Self { state: "expired", username, detail } }
    pub fn unchecked(username: String, detail: String) -> Self { Self { state: "unchecked", username, detail } }
}
/// Access tokens are renewed when they have less than this left.
const RENEW_MARGIN: u64 = 10 * 60;

fn shown_name(connection: &SocialConnection) -> String {
    if connection.username.is_empty() { connection.name.clone() } else { connection.username.clone() }
}

/// What to tell the user when the social refuses to renew a connection.
fn expired_detail(social: Social) -> String {
    match social {
        Social::Youtube => "Google stopped accepting this connection. Press Connect again. If the Google app's consent screen is still in Testing, Google ends connections after 7 days: publish the app to stop that.".into(),
        Social::Tiktok => "TikTok stopped accepting this connection. Press Connect again.".into(),
    }
}

/// Renews the connection's access token when it is about to run out, so posting never finds it
/// expired, and reports whether the social still accepts it.
async fn check(social: Social, profile: &str) -> Result<ConnectionCheck, String> {
    let Some(mut credential) = load(social, profile)? else { return Ok(ConnectionCheck::none()) };
    let username = shown_name(&credential.connection);
    if credential.expires_at > now().saturating_add(RENEW_MARGIN) { return Ok(ConnectionCheck::ok(username)); }
    let Some(dev) = dev_apps::get(social.provider())? else {
        return Ok(ConnectionCheck::expired(username, format!("The {} developer app is no longer set up. Set it up again, then connect.", social.name())));
    };
    let id_field = match social { Social::Youtube => "client_id", Social::Tiktok => "client_key" };
    let url = match social { Social::Youtube => GOOGLE_TOKEN_URL, Social::Tiktok => TIKTOK_TOKEN_URL };
    let form = [(id_field, dev.id.as_str()), ("client_secret", dev.secret.as_str()), ("grant_type", "refresh_token"), ("refresh_token", credential.refresh_token.as_str())];
    let response = match client()?.post(url).form(&form).send().await {
        Ok(response) => response,
        Err(_) => return Ok(ConnectionCheck::unchecked(username, format!("Could not reach {} to check. Try again later.", social.name()))),
    };
    let status = response.status();
    if status.is_server_error() || status.as_u16() == 429 {
        return Ok(ConnectionCheck::unchecked(username, format!("{} is busy right now (HTTP {}). Try again later.", social.name(), status.as_u16())));
    }
    if !status.is_success() { return Ok(ConnectionCheck::expired(username, expired_detail(social))); }
    // TikTok answers refusals with HTTP 200 and no access token, so a missing token counts as refused.
    let Ok(tokens) = response.json::<TokenResponse>().await else { return Ok(ConnectionCheck::expired(username, expired_detail(social))) };
    credential.access_token = tokens.access_token;
    if let Some(refresh) = tokens.refresh_token.filter(|value| !value.is_empty()) { credential.refresh_token = refresh; }
    credential.expires_at = now().saturating_add(tokens.expires_in.unwrap_or(3600));
    save(social, profile, &credential)?;
    Ok(ConnectionCheck::ok(username))
}

/// Checks this profile's YouTube connection and renews it when due.
#[tauri::command]
pub async fn check_youtube_connection(profile: String) -> Result<ConnectionCheck, String> { check(Social::Youtube, &profile).await }
/// Checks this profile's TikTok connection and renews it when due.
#[tauri::command]
pub async fn check_tiktok_connection(profile: String) -> Result<ConnectionCheck, String> { check(Social::Tiktok, &profile).await }

/// Connects a YouTube channel to this profile. emailHint pre-selects the Google account.
#[tauri::command]
pub async fn connect_youtube(app: AppHandle, profile: String, email_hint: Option<String>) -> Result<SocialConnection, String> {
    connect(app, Social::Youtube, profile, email_hint, None).await
}
#[tauri::command]
pub fn youtube_connection(profile: String) -> Result<Option<SocialConnection>, String> { connection(Social::Youtube, &profile) }
#[tauri::command]
pub fn disconnect_youtube(profile: String) -> Result<(), String> { disconnect(Social::Youtube, &profile) }

/// Connects a TikTok account to this profile, with its saved sign-in filled in.
#[tauri::command]
pub async fn connect_tiktok(app: AppHandle, profile: String, username: Option<String>) -> Result<SocialConnection, String> {
    connect(app, Social::Tiktok, profile, None, username).await
}
#[tauri::command]
pub fn tiktok_connection(profile: String) -> Result<Option<SocialConnection>, String> { connection(Social::Tiktok, &profile) }
#[tauri::command]
pub fn disconnect_tiktok(profile: String) -> Result<(), String> { disconnect(Social::Tiktok, &profile) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_addresses_carry_the_app_redirect_and_pkce() {
        let youtube = authorize_url(Social::Youtube, "cid.apps.googleusercontent.com", "st", "verifier", Some("me@gmail.com")).unwrap();
        let pairs: Vec<(String, String)> = youtube.query_pairs().map(|(k, v)| (k.into(), v.into())).collect();
        assert!(pairs.contains(&("redirect_uri".into(), YOUTUBE_REDIRECT_URI.into())));
        assert!(pairs.contains(&("access_type".into(), "offline".into())));
        assert!(pairs.contains(&("login_hint".into(), "me@gmail.com".into())));
        let tiktok = authorize_url(Social::Tiktok, "key", "st", "verifier", None).unwrap();
        let pairs: Vec<(String, String)> = tiktok.query_pairs().map(|(k, v)| (k.into(), v.into())).collect();
        assert!(pairs.contains(&("client_key".into(), "key".into())));
        assert!(pairs.contains(&("code_challenge".into(), challenge_hex("verifier"))));
        assert_eq!(challenge_hex("verifier").len(), 64);
    }

    #[test]
    fn only_the_matching_redirect_is_caught() {
        let parse = |value: &str| url::Url::parse(value).unwrap();
        assert_eq!(redirect_result(Social::Youtube, &parse("http://127.0.0.1:49174/socialspace/youtube?state=st&code=4/abc"), "st"), Some(Ok("4/abc".into())));
        assert!(redirect_result(Social::Youtube, &parse("http://127.0.0.1:49174/socialspace/youtube?state=x&code=4/abc"), "st").unwrap().is_err());
        assert!(redirect_result(Social::Tiktok, &parse("https://localhost/socialspace/tiktok?state=st&error=access_denied"), "st").unwrap().is_err());
        assert_eq!(redirect_result(Social::Tiktok, &parse("https://www.tiktok.com/login"), "st"), None);
        assert_eq!(redirect_result(Social::Youtube, &parse("http://127.0.0.1:9999/socialspace/youtube?state=st&code=1"), "st"), None);
    }
}
