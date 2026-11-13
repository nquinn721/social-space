use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::social_connect::ConnectionCheck;

const REDIRECT_URI: &str = "http://127.0.0.1:49173/callback";
const LISTEN_ADDRESS: &str = "127.0.0.1:49173";
const AUTH_URL: &str = "https://x.com/i/oauth2/authorize";
const TOKEN_URL: &str = "https://api.x.com/2/oauth2/token";
const USER_URL: &str = "https://api.x.com/2/users/me";
const POST_URL: &str = "https://api.x.com/2/tweets";
const KEYRING_SERVICE: &str = "social-manager-x-oauth";
const KEYRING_ENTRY: &str = "primary";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const TOKEN_REFRESH_MARGIN: u64 = 60;
static OPERATION_ACTIVE: AtomicBool = AtomicBool::new(false);

struct OperationGuard;
impl OperationGuard {
    fn acquire() -> Result<Self, String> {
        OPERATION_ACTIVE
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "An X operation is already in progress. Please wait.".to_string())?;
        Ok(Self)
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        OPERATION_ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    id: String,
    username: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XConnection {
    id: String,
    username: String,
    name: String,
}
impl From<&Credential> for XConnection {
    fn from(value: &Credential) -> Self {
        Self {
            id: value.id.clone(),
            username: value.username.clone(),
            name: value.name.clone(),
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}
#[derive(Deserialize)]
struct UserResponse {
    data: XUser,
}
#[derive(Deserialize)]
struct XUser {
    id: String,
    username: String,
    name: String,
}
#[derive(Deserialize)]
struct PostResponse {
    data: XPost,
}
#[derive(Deserialize, Serialize)]
pub struct XPost {
    id: String,
    text: String,
}

/// Each profile keeps its own X connection under its profile id; older ones live under "primary".
fn slot(profile: Option<&str>) -> Result<String, String> {
    crate::instagram::slot(profile).map(|value| if value == "primary" { KEYRING_ENTRY.to_string() } else { value })
}
fn entry(slot: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, slot)
        .map_err(|_| "Could not access secure credential storage.".into())
}
fn load(slot: &str) -> Result<Option<Credential>, String> {
    match entry(slot)?.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
            "Saved X credentials could not be read. Disconnect and reconnect X.".into()
        }),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read X credentials from secure storage.".into()),
    }
}
fn save(slot: &str, credential: &Credential) -> Result<(), String> {
    let value = serde_json::to_string(credential).map_err(|_| "Could not encode X credentials.")?;
    entry(slot)?
        .set_password(&value)
        .map_err(|_| "Could not save X credentials in secure storage.".into())
}
fn random_string() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not securely start X sign-in.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| "System clock is invalid.".into())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start the network client.".into())
}
fn post_error(status: reqwest::StatusCode) -> String {
    format!("X returned HTTP {}. Check X before retrying; the post may have been published. Also check account permissions, API billing, and post content.", status.as_u16())
}
fn authorize_url(client_id: &str, state: &str, verifier: &str) -> Result<String, String> {
    let mut url = Url::parse(AUTH_URL).map_err(|_| "Invalid X authorization URL.")?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", "tweet.read tweet.write users.read offline.access")
        .append_pair("state", state)
        .append_pair("code_challenge", &challenge(verifier))
        .append_pair("code_challenge_method", "S256");
    Ok(url.into())
}

// Reject requests that are not callbacks for this specific sign-in attempt.
fn callback_result(request_line: &str, state: &str) -> Option<Result<String, String>> {
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    if !target.starts_with("/callback?") {
        return None;
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
    if states.len() != 1 || states[0].1 != state {
        return None;
    }
    let codes: Vec<_> = pairs.iter().filter(|(key, _)| key == "code").collect();
    let errors: Vec<_> = pairs.iter().filter(|(key, _)| key == "error").collect();
    if codes.len() == 1 && errors.is_empty() && !codes[0].1.is_empty() {
        Some(Ok(codes[0].1.to_string()))
    } else {
        Some(Err(
            "X authorization was not completed. Please try again.".into()
        ))
    }
}
fn read_callback(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut bytes = [0u8; 8192];
    let count = stream.read(&mut bytes).ok()?;
    let request = std::str::from_utf8(&bytes[..count]).ok()?;
    let result = callback_result(request.lines().next()?, state);
    let body = if result.is_some() {
        "You may return to Social Space."
    } else {
        "Invalid callback."
    };
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(response.as_bytes());
    result
}
fn wait_for_callback(listener: TcpListener, state: String) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not start the X sign-in listener.")?;
    let started = Instant::now();
    while started.elapsed() < LOGIN_TIMEOUT {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = read_callback(stream, &state) {
                    return result;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(_) => return Err("X sign-in listener failed.".into()),
        }
    }
    Err("X sign-in timed out. Please try again.".into())
}
async fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let response = client()?
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|_| "Could not reach X to authorize your account.")?;
    if !response.status().is_success() {
        return Err(format!(
            "X authorization failed (HTTP {}). Check your app configuration and try again.",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|_| "X returned an invalid authorization response.".into())
}

#[tauri::command]
pub async fn connect_x(app: tauri::AppHandle, client_id: Option<String>, profile: Option<String>, username: Option<String>) -> Result<XConnection, String> {
    let _guard = OperationGuard::acquire()?;
    let slot = slot(profile.as_deref())?;
    // The X developer app is set up once; Connect only needs the Client ID typed when it isn't.
    let saved = crate::dev_apps::get(crate::dev_apps::Provider::X)?.map(|app| app.id);
    let client_id = client_id.filter(|value| !value.trim().is_empty()).or(saved).ok_or("SETUP_NEEDED")?;
    let client_id = client_id.trim();
    if client_id.is_empty() || client_id.len() > 256 || client_id.chars().any(char::is_whitespace) {
        return Err("Enter the X OAuth 2.0 Client ID from your Native App.".into());
    }
    let listener = TcpListener::bind(LISTEN_ADDRESS)
        .map_err(|_| "The X sign-in port is in use. Close the other application and try again.")?;
    let state = random_string()?;
    let verifier = random_string()?;
    let url = authorize_url(client_id, &state, &verifier)?;
    let label = crate::browser::open_remote_window(&app, &url, true)?;
    // X's sign-in is filled with the profile's username and saved password; the user presses the buttons.
    if let (Some(id), Some(name)) = (profile.as_deref(), username.as_deref().map(|v| v.trim().trim_start_matches('@')).filter(|v| !v.is_empty())) {
        if let Ok(fields) = serde_json::from_value(serde_json::json!({ "username": name })) {
            let has_password = crate::account_passwords::read(id).ok().flatten().is_some();
            let _ = crate::autofill::fill_site_form(app.clone(), label, fields, None, Some(id.to_string()), Some(has_password), Some(true), None);
        }
    }
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, state))
        .await
        .map_err(|_| "X sign-in could not finish.")??;
    let token = token_request(&[
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("redirect_uri", REDIRECT_URI),
        ("code", &code),
        ("code_verifier", &verifier),
    ])
    .await?;
    let refresh_token = token
        .refresh_token
        .ok_or("X did not return a refresh token. Check that offline access is enabled.")?;
    let response = client()?
        .get(USER_URL)
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|_| "Could not retrieve the connected X account.")?;
    if !response.status().is_success() {
        return Err(format!(
            "X account lookup failed (HTTP {}). Check your API access and billing.",
            response.status().as_u16()
        ));
    }
    let user: UserResponse = response
        .json()
        .await
        .map_err(|_| "X returned an invalid account response.")?;
    let credential = Credential {
        client_id: client_id.into(),
        access_token: token.access_token,
        refresh_token,
        expires_at: now()?.saturating_add(token.expires_in),
        id: user.data.id,
        username: user.data.username,
        name: user.data.name,
    };
    save(&slot, &credential)?;
    Ok(XConnection::from(&credential))
}

#[tauri::command]
pub fn x_connection(profile: Option<String>) -> Result<Option<XConnection>, String> {
    Ok(load(&slot(profile.as_deref())?)?.as_ref().map(XConnection::from))
}

/// Moves an X connection made before per-profile connections onto the profile with that username.
#[tauri::command]
pub fn claim_x_connection(profile: String, username: String) -> Result<Option<XConnection>, String> {
    let _guard = OperationGuard::acquire()?;
    let target = slot(Some(&profile))?;
    if target == KEYRING_ENTRY || load(&target)?.is_some() {
        return x_connection(Some(profile));
    }
    let wanted = username.trim().trim_start_matches('@').to_lowercase();
    match load(KEYRING_ENTRY)? {
        Some(old) if !wanted.is_empty() && old.username.to_lowercase() == wanted => {
            save(&target, &old)?;
            let _ = entry(KEYRING_ENTRY)?.delete_credential();
            Ok(Some(XConnection::from(&old)))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn disconnect_x(profile: Option<String>) -> Result<(), String> {
    let _guard = OperationGuard::acquire()?;
    match entry(&slot(profile.as_deref())?)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove X credentials from secure storage.".into()),
    }
}

/// Checks this profile's X connection, renewing it when due, so posting never finds it expired.
#[tauri::command]
pub async fn check_x_connection(profile: String) -> Result<ConnectionCheck, String> {
    let _guard = OperationGuard::acquire()?;
    let slot = slot(Some(&profile))?;
    let Some(mut credential) = load(&slot)? else { return Ok(ConnectionCheck::none()) };
    let username = credential.username.clone();
    if credential.expires_at > now()?.saturating_add(TOKEN_REFRESH_MARGIN) { return Ok(ConnectionCheck::ok(username)); }
    let form = [("grant_type", "refresh_token"), ("client_id", credential.client_id.as_str()), ("refresh_token", credential.refresh_token.as_str())];
    let response = match client()?.post(TOKEN_URL).form(&form).send().await {
        Ok(response) => response,
        Err(_) => return Ok(ConnectionCheck::unchecked(username, "Could not reach X to check. Try again later.".into())),
    };
    let status = response.status();
    if status.is_server_error() || status.as_u16() == 429 {
        return Ok(ConnectionCheck::unchecked(username, format!("X is busy right now (HTTP {}). Try again later.", status.as_u16())));
    }
    let refused = || ConnectionCheck::expired(credential.username.clone(), "X stopped accepting this connection. Press Connect again.".into());
    if !status.is_success() { return Ok(refused()); }
    let Ok(token) = response.json::<TokenResponse>().await else { return Ok(refused()) };
    credential.access_token = token.access_token;
    if let Some(refresh) = token.refresh_token { credential.refresh_token = refresh; }
    credential.expires_at = now()?.saturating_add(token.expires_in);
    save(&slot, &credential)?;
    Ok(ConnectionCheck::ok(username))
}

#[tauri::command]
pub async fn post_to_x(text: String, profile: Option<String>) -> Result<XPost, String> {
    let _guard = OperationGuard::acquire()?;
    let slot = slot(profile.as_deref())?;
    if text.trim().is_empty() || text.len() > 25_000 {
        return Err("Enter a post before publishing to X.".into());
    }
    let mut credential = load(&slot)?.ok_or("Connect this X profile before posting.")?;
    if credential.expires_at <= now()?.saturating_add(TOKEN_REFRESH_MARGIN) {
        let token = token_request(&[
            ("grant_type", "refresh_token"),
            ("client_id", &credential.client_id),
            ("refresh_token", &credential.refresh_token),
        ])
        .await?;
        credential.access_token = token.access_token;
        if let Some(refresh) = token.refresh_token {
            credential.refresh_token = refresh;
        }
        credential.expires_at = now()?.saturating_add(token.expires_in);
        save(&slot, &credential)?;
    }
    let response = client()?.post(POST_URL).bearer_auth(&credential.access_token).json(&serde_json::json!({ "text": text })).send().await.map_err(|_| "The X request did not complete. Check X before retrying; the post may have been published." )?;
    if !response.status().is_success() {
        return Err(post_error(response.status()));
    }
    let result: PostResponse = response.json().await.map_err(|_| {
        "X accepted the request but returned an unreadable response. Check X before retrying."
    })?;
    Ok(result.data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_client_rejects_plain_http() {
        tauri::async_runtime::block_on(async {
            let error = client()
                .unwrap()
                .get("http://127.0.0.1:49173/")
                .send()
                .await
                .unwrap_err();
            assert!(error.is_builder());
        });
    }

    #[test]
    fn post_error_does_not_encourage_blind_retry() {
        let error = post_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.contains("Check X before retrying"));
        assert!(error.contains("500"));
    }
    #[test]
    fn pkce_matches_rfc_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn callback_requires_matching_state_and_path() {
        assert_eq!(
            callback_result("GET /callback?state=expected&code=abc HTTP/1.1", "expected"),
            Some(Ok("abc".into()))
        );
        assert!(
            callback_result("GET /callback?state=other&code=abc HTTP/1.1", "expected").is_none()
        );
        assert!(
            callback_result("GET /other?state=expected&code=abc HTTP/1.1", "expected").is_none()
        );
        assert!(callback_result(
            "GET /callback?state=expected&state=other&code=abc HTTP/1.1",
            "expected"
        )
        .is_none());
        assert!(matches!(
            callback_result(
                "GET /callback?state=expected&error=denied HTTP/1.1",
                "expected"
            ),
            Some(Err(_))
        ));
    }
    #[test]
    fn authorization_has_required_scopes_and_pkce() {
        let url = Url::parse(&authorize_url("client", "state", "verifier").unwrap()).unwrap();
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["redirect_uri"], REDIRECT_URI);
        assert_eq!(params["code_challenge_method"], "S256");
        assert!(params["scope"].contains("tweet.write"));
        assert!(params["scope"].contains("offline.access"));
    }
}
