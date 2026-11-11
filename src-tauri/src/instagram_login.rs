//! One-click Instagram connection through "Business Login for Instagram".
//!
//! Connect opens Instagram's own approval page in an app window, with the saved
//! username and password of the chosen profile filled in. The user presses Log in
//! and Allow themselves. Instagram then redirects to REDIRECT_URI; the window
//! catches that address (it is never loaded), and the code is swapped for a
//! long-lived token, which the existing Instagram connection stores.
//!
//! This needs one Meta app, entered once and kept in Windows Credential Manager.
//! Two kinds work:
//! - newer apps only offer "API setup with Unified login" (Facebook Login for
//!   Business with a configuration). The configuration ID is saved too, the user
//!   approves on Facebook's page, and the token is a business system-user token for
//!   graph.facebook.com. No Facebook Page is needed.
//! - older apps with "API setup with Instagram login" use Instagram's own page.

use std::{
    sync::{mpsc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// Must be registered as the Redirect URL in the Meta app. It is caught in the window
/// and never actually requested. Meta rejects localhost, so it is an HTTPS address on
/// the repo owner's GitHub Pages domain, which nobody else can serve.
pub const REDIRECT_URI: &str = "https://nquinn721.github.io/socialspace/instagram";
const AUTHORIZE_URL: &str = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL: &str = "https://api.instagram.com/oauth/access_token";
const LONG_TOKEN_URL: &str = "https://graph.instagram.com/access_token";
const SCOPES: &str = "instagram_business_basic,instagram_business_content_publish";
const GRAPH_VERSION: &str = "v25.0";
const FACEBOOK_DIALOG: &str = "https://www.facebook.com";
const FACEBOOK_GRAPH: &str = "https://graph.facebook.com";
#[cfg(windows)]
const CONFIG_SERVICE: &str = "social-manager-meta-login-config";
#[cfg(windows)]
const CONFIG_ENTRY: &str = "meta";
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
static BUSY: Mutex<bool> = Mutex::new(false);
/// Marks the error Connect returns when Meta connected but would not say which Instagram account.
pub const ID_NEEDED: &str = "INSTAGRAM_ID_NEEDED";
/// A working business token whose Instagram account could not be looked up, kept in memory only
/// (never on disk) per profile slot until the user gives the account ID.
static PENDING: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

fn keep_pending(slot: &str, token: &str) {
    if let Ok(mut pending) = PENDING.lock() {
        pending.get_or_insert_with(std::collections::HashMap::new).insert(slot.to_owned(), token.to_owned());
    }
}
fn pending_token(slot: &str) -> Option<String> {
    PENDING.lock().ok()?.as_ref()?.get(slot).cloned()
}
fn forget_pending(slot: &str) {
    if let Ok(mut pending) = PENDING.lock() {
        if let Some(map) = pending.as_mut() { map.remove(slot); }
    }
}

struct MetaApp {
    app_id: String,
    app_secret: String,
    /// Set for Unified login apps: the Facebook Login for Business configuration to approve.
    config_id: Option<String>,
}

#[cfg(windows)]
fn config_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CONFIG_SERVICE, CONFIG_ENTRY).map_err(|_| "Windows Credential Manager is unavailable.".into())
}
#[cfg(windows)]
fn load_config_id() -> Result<Option<String>, String> {
    match config_entry()?.get_password() {
        Ok(value) => Ok(Some(value).filter(|value| valid_config_id(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the saved Meta configuration.".into()),
    }
}
#[cfg(not(windows))]
fn load_config_id() -> Result<Option<String>, String> { Ok(None) }
#[cfg(windows)]
fn save_config_id(config_id: Option<&str>) -> Result<(), String> {
    let entry = config_entry()?;
    match config_id {
        Some(value) => entry.set_password(value).map_err(|_| "Could not save the Meta configuration.".into()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not update the Meta configuration.".into()),
        },
    }
}
#[cfg(not(windows))]
fn save_config_id(_config_id: Option<&str>) -> Result<(), String> { Ok(()) }

fn valid_config_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit())
}

/// The Meta app is the "meta" developer app, set up once in Settings or on first Connect.
fn load_app() -> Result<Option<MetaApp>, String> {
    let Some(app) = crate::dev_apps::get(crate::dev_apps::Provider::Meta)? else { return Ok(None) };
    Ok(Some(MetaApp { app_id: app.id, app_secret: app.secret, config_id: load_config_id()? }))
}

fn valid_app(app_id: &str, app_secret: &str) -> bool {
    !app_id.is_empty() && app_id.len() <= 32 && app_id.bytes().all(|b| b.is_ascii_digit())
        && (16..=128).contains(&app_secret.len()) && app_secret.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Whether the one-time Meta app details are saved, so Connect can be a single click.
#[tauri::command]
pub fn instagram_app_ready() -> Result<bool, String> {
    Ok(load_app()?.is_some_and(|app| app.config_id.is_some()))
}

/// Saves the Meta app once: its App ID and secret, plus the configuration ID for Unified login apps.
#[tauri::command]
pub fn save_instagram_app(app_id: String, app_secret: String, config_id: Option<String>) -> Result<(), String> {
    let (app_id, app_secret) = (app_id.trim(), app_secret.trim());
    if !valid_app(app_id, app_secret) {
        return Err("Enter the App ID (numbers only) and the App Secret from the Meta app.".into());
    }
    let config_id = config_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if config_id.is_some_and(|value| !valid_config_id(value)) {
        return Err("The Configuration ID is the number shown for your configuration in Meta.".into());
    }
    crate::dev_apps::save(crate::dev_apps::Provider::Meta, app_id, app_secret)?;
    save_config_id(config_id)
}

/// Facebook Login for Business: the configuration decides the token type, assets and permissions,
/// so no scope is sent. System-user configurations need override_default_response_type.
fn unified_authorize_url(app_id: &str, config_id: &str, state: &str) -> Result<url::Url, String> {
    // Same address and parameters as the "Login URL" Meta generates for the configuration.
    url::Url::parse_with_params(&format!("{FACEBOOK_DIALOG}/dialog/oauth"), &[
        ("client_id", app_id),
        ("config_id", config_id),
        ("redirect_uri", REDIRECT_URI),
        ("response_type", "code"),
        ("override_default_response_type", "true"),
        ("state", state),
    ]).map_err(|_| "Could not build the Meta approval address.".into())
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

#[derive(Deserialize, Debug)]
struct IgAccount { id: String, #[serde(default)] username: String }
#[derive(Deserialize)]
struct IgAccounts { #[serde(default)] data: Vec<IgAccount> }
#[derive(Deserialize)]
struct PageAccounts { #[serde(default)] data: Vec<PageWithIg> }
#[derive(Deserialize)]
struct PageWithIg { instagram_business_account: Option<IgAccount> }

async fn unified_exchange(app: &MetaApp, code: &str) -> Result<String, String> {
    let http = reqwest::Client::builder().https_only(true).timeout(HTTP_TIMEOUT).build().map_err(|_| "Could not reach Meta.")?;
    let response = http.get(format!("{FACEBOOK_GRAPH}/{GRAPH_VERSION}/oauth/access_token")).query(&[
        ("client_id", app.app_id.as_str()),
        ("client_secret", app.app_secret.as_str()),
        ("redirect_uri", REDIRECT_URI),
        ("code", code),
    ]).send().await.map_err(|_| "Could not reach Meta.")?;
    if !response.status().is_success() {
        return Err(format!("Meta did not accept the approval (HTTP {}). Check the App ID, App Secret, Configuration ID and redirect address.", response.status().as_u16()));
    }
    let token: ShortToken = response.json().await.map_err(|_| "Meta returned an unexpected answer.")?;
    Ok(token.access_token)
}

/// Picks the account to post from: the one matching the profile's handle, else the only one.
fn choose_account(accounts: Vec<IgAccount>, wanted: Option<&str>) -> Result<IgAccount, String> {
    let accounts: Vec<IgAccount> = accounts.into_iter().filter(|account| !account.id.is_empty() && account.id.bytes().all(|b| b.is_ascii_digit())).collect();
    if let Some(wanted) = wanted {
        if let Some(index) = accounts.iter().position(|account| account.username.eq_ignore_ascii_case(wanted)) {
            return Ok(accounts.into_iter().nth(index).expect("index is in range"));
        }
    }
    match accounts.len() {
        0 => Err("Meta did not share an Instagram account. In your configuration, add the Instagram account as an asset, then press Connect again.".into()),
        1 => Ok(accounts.into_iter().next().expect("one account")),
        _ => Err(format!("Meta shared several Instagram accounts ({}). Connect from the profile whose handle matches the one to use.",
            accounts.iter().map(|account| format!("@{}", account.username)).collect::<Vec<_>>().join(", "))),
    }
}

/// Meta's error text from a failed Graph call, without anything secret (tokens are never echoed).
async fn meta_error(response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let message = response.json::<serde_json::Value>().await.ok()
        .and_then(|body| body.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_owned))
        .unwrap_or_default();
    let message: String = message.chars().take(160).collect();
    if message.is_empty() { format!("HTTP {status}") } else { format!("HTTP {status}: {message}") }
}

#[derive(Deserialize)]
struct DebugToken { data: DebugData }
#[derive(Deserialize)]
struct DebugData {
    #[serde(default)] granular_scopes: Vec<GranularScope>,
    #[serde(default, rename = "type")] token_type: Option<String>,
    #[serde(default)] scopes: Vec<String>,
}
#[derive(Deserialize, Clone)]
struct GranularScope { scope: String, #[serde(default)] target_ids: Vec<String> }

/// The Instagram account IDs the person granted in the approval window, as Meta records them on the token.
fn granted_instagram_ids(debug: &DebugToken) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for scope in debug.data.granular_scopes.iter().cloned() {
        if scope.scope.starts_with("instagram_") {
            for id in scope.target_ids {
                if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) && !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    ids
}

/// A short, secret-free description of the token for error messages: its type and permissions.
fn describe_token(debug: &DebugToken) -> String {
    let kind = debug.data.token_type.clone().unwrap_or_else(|| "unknown".into());
    let scopes: Vec<&str> = debug.data.scopes.iter().map(String::as_str).filter(|scope| scope.starts_with("instagram") || scope.starts_with("business")).collect();
    format!("token type {kind}, permissions {}", if scopes.is_empty() { "none for Instagram".to_string() } else { scopes.join(",") })
}

/// Reads a list of Instagram accounts from one Graph address, noting what Meta said if it fails.
async fn list_accounts(http: &reqwest::Client, url: String, token: &str, label: &str, notes: &mut Vec<String>) -> Vec<IgAccount> {
    match http.get(url).query(&[("fields", "id,username")]).bearer_auth(token).send().await {
        Ok(response) if response.status().is_success() => {
            let accounts = response.json::<IgAccounts>().await.map(|list| list.data).unwrap_or_default();
            if accounts.is_empty() { notes.push(format!("{label}: none")); }
            accounts
        }
        Ok(response) => { notes.push(format!("{label}: {}", meta_error(response).await)); Vec::new() }
        Err(_) => { notes.push(format!("{label}: no answer")); Vec::new() }
    }
}

#[derive(Deserialize)]
struct ClientBusiness { #[serde(default)] client_business_id: Option<String> }

/// Finds the Instagram account a Unified login token can post for. Tries, in order: the accounts
/// granted on the token itself (debug_token), the system user's assigned accounts, the client
/// business's Instagram accounts, and Pages.
/// When nothing is found, the error says what Meta answered to each, so it can be fixed.
async fn unified_account(app: &MetaApp, token: &str, wanted: Option<&str>) -> Result<IgAccount, String> {
    let http = reqwest::Client::builder().https_only(true).timeout(HTTP_TIMEOUT).build().map_err(|_| "Could not reach Meta.")?;
    let base = format!("{FACEBOOK_GRAPH}/{GRAPH_VERSION}");
    let mut notes: Vec<String> = Vec::new();
    let mut accounts: Vec<IgAccount> = Vec::new();

    let app_token = format!("{}|{}", app.app_id, app.app_secret);
    match http.get(format!("{base}/debug_token")).query(&[("input_token", token), ("access_token", app_token.as_str())]).send().await {
        Ok(response) if response.status().is_success() => match response.json::<DebugToken>().await {
            Ok(debug) => {
                let ids = granted_instagram_ids(&debug);
                notes.push(describe_token(&debug));
                if ids.is_empty() { notes.push("token lists no Instagram account".into()); }
                for id in ids {
                    match http.get(format!("{base}/{id}")).query(&[("fields", "id,username")]).bearer_auth(token).send().await {
                        Ok(response) if response.status().is_success() => {
                            if let Ok(account) = response.json::<IgAccount>().await { accounts.push(account); }
                        }
                        Ok(response) => notes.push(format!("account {id}: {}", meta_error(response).await)),
                        Err(_) => notes.push(format!("account {id}: no answer")),
                    }
                }
            }
            Err(_) => notes.push("token check unreadable".into()),
        },
        Ok(response) => notes.push(format!("token check: {}", meta_error(response).await)),
        Err(_) => notes.push("token check: no answer".into()),
    }

    if accounts.is_empty() {
        accounts = list_accounts(&http, format!("{base}/me/assigned_instagram_accounts"), token, "assigned accounts", &mut notes).await;
    }
    if accounts.is_empty() {
        accounts = list_accounts(&http, format!("{base}/me/instagram_accounts"), token, "my accounts", &mut notes).await;
    }
    if accounts.is_empty() {
        // A business system-user token belongs to the client's business portfolio, which owns the account.
        let business = match http.get(format!("{base}/me")).query(&[("fields", "client_business_id")]).bearer_auth(token).send().await {
            Ok(response) if response.status().is_success() => response.json::<ClientBusiness>().await.ok().and_then(|me| me.client_business_id),
            Ok(response) => { notes.push(format!("business: {}", meta_error(response).await)); None }
            Err(_) => { notes.push("business: no answer".into()); None }
        };
        match business.filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())) {
            Some(id) => {
                accounts = list_accounts(&http, format!("{base}/{id}/owned_instagram_accounts"), token, "business accounts", &mut notes).await;
                if accounts.is_empty() {
                    accounts = list_accounts(&http, format!("{base}/{id}/instagram_accounts"), token, "business instagram", &mut notes).await;
                }
            }
            None => notes.push("business: not a business token".into()),
        }
    }
    if accounts.is_empty() {
        match http.get(format!("{base}/me/accounts")).query(&[("fields", "instagram_business_account{id,username}")]).bearer_auth(token).send().await {
            Ok(response) if response.status().is_success() => {
                accounts = response.json::<PageAccounts>().await.map(|pages| pages.data.into_iter().filter_map(|page| page.instagram_business_account).collect()).unwrap_or_default();
                if accounts.is_empty() { notes.push("pages: none".into()); }
            }
            Ok(response) => notes.push(format!("pages: {}", meta_error(response).await)),
            Err(_) => notes.push("pages: no answer".into()),
        }
    }
    if accounts.is_empty() {
        return Err(format!("Meta did not share an Instagram account. In the Facebook window, make sure the Instagram account is selected, then press Connect again. (Meta said: {})", notes.join("; ")));
    }
    choose_account(accounts, wanted)
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
    // New Meta apps only offer Unified login, so an app saved without its configuration
    // (from the earlier form) is set up again instead of opening Instagram's page, which fails.
    let meta = load_app()?.filter(|app| app.config_id.is_some()).ok_or("SETUP_NEEDED")?;
    let state = random_state()?;
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    let label = format!("site-instagram-{}", &state[..8]);
    let approval_url = match &meta.config_id {
        Some(config_id) => unified_authorize_url(&meta.app_id, config_id, &state)?,
        None => authorize_url(&meta.app_id, &state)?,
    };
    let caught = sender.clone();
    let expected = state.clone();
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(approval_url))
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
    // Facebook's page asks for a Facebook (or Instagram) sign-in, so only Instagram's own page is pre-filled.
    if let (Some(name), None) = (&username, &meta.config_id) {
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
    let slot = crate::instagram::slot(account_id.as_deref())?;
    if meta.config_id.is_some() {
        let token = unified_exchange(&meta, &code).await?;
        if token.trim().is_empty() || token.chars().any(char::is_whitespace) {
            return Err("Meta returned an invalid token.".into());
        }
        let account = match unified_account(&meta, &token, username.as_deref()).await {
            Ok(account) => account,
            // Meta connected but kept the account list behind business_management: keep the token
            // in memory and ask for the account ID instead of making the user sign in again.
            Err(reason) => { keep_pending(&slot, &token); return Err(format!("{ID_NEEDED}: {reason}")); }
        };
        forget_pending(&slot);
        return crate::instagram::store(&slot, &account.id, &token, crate::instagram::LoginKind::Facebook).await;
    }
    let token = exchange(&meta, &code).await?;
    if token.trim().is_empty() || token.chars().any(char::is_whitespace) {
        return Err("Instagram returned an invalid token.".into());
    }
    // The connection belongs to the profile that pressed Connect.
    crate::instagram::store(&slot, "", &token, crate::instagram::LoginKind::Instagram).await
}

/// Finishes a Connect that Meta approved but whose Instagram account could not be looked up,
/// using the account ID from Meta Business Settings. Meta checks the ID against the token.
#[tauri::command]
pub async fn finish_instagram_connection(profile: Option<String>, instagram_id: String) -> Result<crate::instagram::InstagramConnection, String> {
    let slot = crate::instagram::slot(profile.as_deref())?;
    let id = instagram_id.trim();
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("The Instagram account ID is the long number under the account in Meta Business Settings.".into());
    }
    let token = pending_token(&slot).ok_or("Press Connect again first, then enter the ID.")?;
    let connection = crate::instagram::store(&slot, id, &token, crate::instagram::LoginKind::Facebook).await
        .map_err(|reason| format!("Meta did not accept that account ID for this connection. {reason}"))?;
    forget_pending(&slot);
    Ok(connection)
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
        assert_eq!(redirect_result(&parse("https://nquinn721.github.io/socialspace/instagram?code=AQB1&state=abc#_"), "abc"), Some(Ok("AQB1".into())));
        assert!(redirect_result(&parse("https://nquinn721.github.io/socialspace/instagram?code=AQB1&state=other"), "abc").unwrap().is_err());
        assert!(redirect_result(&parse("https://nquinn721.github.io/socialspace/instagram?error=access_denied&state=abc"), "abc").unwrap().is_err());
        assert_eq!(redirect_result(&parse("https://www.instagram.com/accounts/login/"), "abc"), None);
    }

    #[test]
    fn unified_approval_uses_the_configuration_and_no_scope() {
        let url = unified_authorize_url("123456", "987654", "abc").unwrap();
        assert!(url.as_str().starts_with("https://www.facebook.com/dialog/oauth?"));
        let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into(), v.into())).collect();
        for pair in [("client_id", "123456"), ("config_id", "987654"), ("redirect_uri", REDIRECT_URI), ("response_type", "code"), ("override_default_response_type", "true"), ("state", "abc")] {
            assert!(query.contains(&(pair.0.into(), pair.1.into())), "{pair:?}");
        }
        assert!(!query.iter().any(|(key, _)| key == "scope"));
    }

    #[test]
    fn facebook_redirect_with_fragment_is_caught() {
        let url = url::Url::parse("https://nquinn721.github.io/socialspace/instagram?code=AQD9&state=abc#_=_").unwrap();
        assert_eq!(redirect_result(&url, "abc"), Some(Ok("AQD9".into())));
    }

    #[test]
    fn the_matching_or_only_instagram_account_is_chosen() {
        let account = |id: &str, name: &str| IgAccount { id: id.into(), username: name.into() };
        assert_eq!(choose_account(vec![account("1", "other"), account("2", "SoftWings")], Some("softwings")).unwrap().id, "2");
        assert_eq!(choose_account(vec![account("3", "massagewithmia")], Some("softwings")).unwrap().id, "3");
        assert!(choose_account(vec![], None).unwrap_err().contains("asset"));
        assert!(choose_account(vec![account("1", "a"), account("2", "b")], None).unwrap_err().contains("@a, @b"));
        assert!(choose_account(vec![account("../x", "a")], None).is_err());
    }

    #[test]
    fn granted_instagram_accounts_are_read_from_the_token() {
        let debug: DebugToken = serde_json::from_value(serde_json::json!({ "data": { "granular_scopes": [
            { "scope": "instagram_basic", "target_ids": ["17841466785898395"] },
            { "scope": "instagram_content_publish", "target_ids": ["17841466785898395", "../x"] },
            { "scope": "ads_read", "target_ids": ["999"] },
            { "scope": "business_management" }
        ] } })).unwrap();
        assert_eq!(granted_instagram_ids(&debug), vec!["17841466785898395".to_string()]);
    }

    #[test]
    fn token_description_names_type_and_instagram_permissions_only() {
        let debug: DebugToken = serde_json::from_value(serde_json::json!({ "data": {
            "type": "SYSTEM_USER", "scopes": ["instagram_basic", "instagram_content_publish", "ads_read"]
        } })).unwrap();
        assert_eq!(describe_token(&debug), "token type SYSTEM_USER, permissions instagram_basic,instagram_content_publish");
        let empty: DebugToken = serde_json::from_value(serde_json::json!({ "data": {} })).unwrap();
        assert_eq!(describe_token(&empty), "token type unknown, permissions none for Instagram");
    }

    #[test]
    fn pending_tokens_are_kept_per_profile_until_used() {
        keep_pending("profile-a", "EAAtoken");
        assert_eq!(pending_token("profile-a").as_deref(), Some("EAAtoken"));
        assert_eq!(pending_token("profile-b"), None);
        forget_pending("profile-a");
        assert_eq!(pending_token("profile-a"), None);
    }

    #[test]
    fn finishing_rejects_ids_that_are_not_numbers() {
        let result = tauri::async_runtime::block_on(finish_instagram_connection(Some("p1".into()), "../me".into()));
        assert!(result.err().unwrap().contains("long number"));
        let result = tauri::async_runtime::block_on(finish_instagram_connection(Some("p1".into()), "123".into()));
        assert!(result.err().unwrap().contains("Press Connect again"));
    }

    #[test]
    fn configuration_ids_are_numbers() {
        assert!(valid_config_id("1234567890123456"));
        assert!(!valid_config_id(""));
        assert!(!valid_config_id("12a"));
    }

    #[test]
    fn meta_app_details_are_checked() {
        assert!(valid_app("1234567890", "0123456789abcdef0123456789abcdef"));
        assert!(!valid_app("12ab", "0123456789abcdef"));
        assert!(!valid_app("123", "short"));
    }
}
