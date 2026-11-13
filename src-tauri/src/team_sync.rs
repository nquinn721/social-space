//! Team sync: two copies of the app (Nate's and his partner's) share their brands, accounts and every
//! saved sign-in through the Firebase project the review site uses.
//!
//! Everything is end-to-end encrypted. Both apps derive one AES-256-GCM key from a team passphrase
//! (PBKDF2, salt kept in `team/meta`), keep the key in Windows Credential Manager, and only ever
//! upload ciphertext. Firestore holds three documents:
//! - `team/meta`: salt, iteration count and an encrypted check value that tells a wrong passphrase apart.
//! - `team/marker`: the revision number only. Each app reads just this every minute (one small read),
//!   which keeps both apps well inside Firebase's free daily allowance.
//! - `team/data`: the encrypted payload, read only when the marker's revision changed. It is written
//!   together with the marker in one commit that only succeeds if nobody wrote in between.
//!
//! Merging is three-way against the last synced copy (the base, kept in `team-sync.json`): the shared
//! workspace parts are merged item by item in the front end (`workspaceSync.ts`); secrets are merged
//! here, so they never reach the web view. The base keeps only SHA-256 hashes of secrets.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::brand_images;
use crate::review::{self, ServiceAccount};

const KEY_SERVICE: &str = "social-manager-team-sync";
const KEY_ENTRY: &str = "key";
const STATE_FILE: &str = "team-sync.json";
/// The Firestore collection; tests use their own so they never touch the real shared data.
const COLLECTION: &str = if cfg!(test) { "team-test" } else { "team" };
const ITERATIONS: u32 = 600_000;
const MIN_PASSPHRASE: usize = 8;
const CHECK_TEXT: &[u8] = b"socialspace-team-v1";
/// Firestore documents top out at 1 MiB; leave room for the base64 growth and other fields.
const MAX_PAYLOAD: usize = 700 * 1024;

/// Credential Manager services whose entries are shared, and the fixed entries each one uses besides
/// one per account (`per_account`). Anything not listed here stays on its own PC.
const SHARED_SERVICES: &[(&str, &[&str], bool)] = &[
    // Account passwords, plus the developer-site passwords of the guided developer-app setup.
    ("social-manager-account-password", &["developer-meta", "developer-x", "developer-tiktok", "developer-google"], true),
    ("social-manager-instagram-page", &["primary"], true),
    ("social-manager-x-oauth", &["primary"], true),
    ("social-manager-youtube", &[], true),
    ("social-manager-tiktok", &[], true),
    // App keys in use, and production keys saved ahead while an app still runs on test keys.
    ("social-manager-developer-app", &["meta", "x", "tiktok", "google", "meta-production", "x-production", "tiktok-production", "google-production"], false),
    ("social-manager-meta-login-config", &["meta"], false),
    ("social-manager-email", &["primary"], false),
    // The Gemini key for brand pictures.
    (crate::gemini_ai::KEY_SERVICE, &[crate::gemini_ai::KEY_ENTRY], false),
    // API keys of the video sources (Kling, Grok), one per source id listed in video-sources.json.
    (VIDEO_SOURCE_SERVICE, &[], false),
];
const VIDEO_SOURCE_SERVICE: &str = "social-manager-video-source";

/// App data files shared whole: the list of video sources (names, providers, which one is active).
const SHARED_FILES: &[&str] = &["video-sources.json", crate::browser_sessions::SESSIONS_FILE];
/// Shared files that are JSON objects merged key by key (one brand's sign-ins at a time), so both PCs
/// can save different brands at once. The others are taken whole.
const KEYED_FILES: &[&str] = &[crate::browser_sessions::SESSIONS_FILE];

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct State {
    #[serde(default)]
    rev: u64,
    /// The shared workspace as last synced, or None before the first sync on this PC.
    #[serde(default)]
    base: Option<Value>,
    /// "service|entry" -> SHA-256 of the secret as last synced.
    #[serde(default)]
    secret_hashes: BTreeMap<String, String>,
    #[serde(default)]
    last_synced_at: u64,
    /// File name -> SHA-256 of the shared file as last synced.
    #[serde(default)]
    file_hashes: BTreeMap<String, String>,
    /// Brand pictures already in the cloud (each is its own `img-<hash>` document and never changes).
    #[serde(default)]
    images_in_cloud: BTreeSet<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Payload {
    workspace: Value,
    /// "service|entry" -> base64 of the raw Credential Manager bytes.
    secrets: BTreeMap<String, String>,
    /// Shared app data files: name -> base64 of their bytes.
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// What the last fetch saw on the server, for the push that follows it.
struct Seen {
    rev: u64,
    /// The marker's update time, used as the commit's precondition; None if no marker exists yet.
    marker_time: Option<String>,
    remote_workspace: Option<Value>,
    /// Hashes of the server's secrets, when the payload was read; None means they equal the base.
    remote_hashes: Option<BTreeMap<String, String>>,
    /// Hashes of the server's shared files, when the payload was read; None means they equal the base.
    remote_file_hashes: Option<BTreeMap<String, String>>,
}

static SEEN: Mutex<Option<Seen>> = Mutex::new(None);
static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStatus {
    review_connected: bool,
    enabled: bool,
    last_synced_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    rev: u64,
    /// The shared workspace on the server, or None if nothing has been shared yet.
    remote: Option<Value>,
    /// The shared workspace as this PC last synced it (None on the first sync).
    base: Option<Value>,
    /// How many saved sign-ins came in from the other PC.
    secrets_received: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    rev: u64,
    pushed: bool,
    /// Someone else wrote first; fetch and merge again.
    conflict: bool,
}

// ---- Local state and key ------------------------------------------------------------------------------

fn read_state(dir: &std::path::Path) -> Result<State, String> {
    match std::fs::read(dir.join(STATE_FILE)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(format!("Could not read the sync state: {e}")),
    }
}

fn write_state(dir: &std::path::Path, state: &State) -> Result<(), String> {
    let path = dir.join(STATE_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create the app data folder: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| format!("Could not save the sync state: {e}"))
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, KEY_ENTRY).map_err(|_| "Windows Credential Manager is unavailable.".into())
}

fn load_team_key() -> Result<Option<[u8; 32]>, String> {
    match key_entry()?.get_secret() {
        Ok(bytes) => bytes.try_into().map(Some).map_err(|_| "The saved team key is damaged. Turn sharing off and on again.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Couldn't read the team key from Windows Credential Manager.".into()),
    }
}

fn require_team_key() -> Result<[u8; 32], String> {
    load_team_key()?.ok_or_else(|| "Sharing isn't turned on on this PC.".into())
}

// ---- Encryption ---------------------------------------------------------------------------------------

fn seal(key: &[u8; 32], plain: &[u8]) -> Result<(String, String), String> {
    let nonce = crate::backup::random::<12>()?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Could not prepare encryption.")?;
    let data = cipher.encrypt(Nonce::from_slice(&nonce), plain).map_err(|_| "Could not encrypt the shared data.")?;
    Ok((STANDARD.encode(nonce), STANDARD.encode(data)))
}

fn open(key: &[u8; 32], nonce: &str, data: &str) -> Result<Vec<u8>, String> {
    let nonce = STANDARD.decode(nonce).map_err(|_| "The shared data is damaged.")?;
    let data = STANDARD.decode(data).map_err(|_| "The shared data is damaged.")?;
    if nonce.len() != 12 {
        return Err("The shared data is damaged.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Could not prepare decryption.")?;
    cipher.decrypt(Nonce::from_slice(&nonce), data.as_ref()).map_err(|_| "The team passphrase on this PC doesn't match the shared data. Turn sharing off and on again with the right passphrase.".into())
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// ---- Secrets ------------------------------------------------------------------------------------------

fn valid_entry(entry: &str) -> bool {
    !entry.is_empty() && entry.len() <= 128 && entry.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Splits "service|entry" and checks the service is shared and the entry is well formed.
fn parse_slot(slot: &str) -> Option<(&'static str, String)> {
    let (service, entry) = slot.split_once('|')?;
    let shared = SHARED_SERVICES.iter().find(|(name, _, _)| *name == service)?;
    valid_entry(entry).then(|| (shared.0, entry.to_string()))
}

/// Every Credential Manager slot that may hold a shared secret for these accounts.
fn candidate_slots(account_ids: &BTreeSet<String>, source_ids: &BTreeSet<String>) -> BTreeSet<String> {
    let mut slots: BTreeSet<String> = source_ids.iter().filter(|id| valid_entry(id)).map(|id| format!("{VIDEO_SOURCE_SERVICE}|{id}")).collect();
    for (service, fixed, per_account) in SHARED_SERVICES {
        for entry in *fixed {
            slots.insert(format!("{service}|{entry}"));
        }
        if *per_account {
            for id in account_ids.iter().filter(|id| valid_entry(id)) {
                slots.insert(format!("{service}|{id}"));
            }
        }
    }
    slots
}

/// Account ids found in a shared workspace value.
fn accounts_in(workspace: Option<&Value>) -> impl Iterator<Item = String> + '_ {
    let accounts = workspace.and_then(|w| w["accounts"].as_array()).into_iter().flatten().filter_map(|a| a["id"].as_str().map(String::from));
    // Every developer-site sign-in owns a `developer-<provider>` password too.
    let developers = workspace.and_then(|w| w["developerLogins"].as_object()).into_iter().flatten().map(|(provider, _)| format!("developer-{provider}"));
    accounts.chain(developers)
}

/// Video source ids listed in a video-sources.json.
fn source_ids(bytes: Option<&[u8]>) -> BTreeSet<String> {
    let value: Value = bytes.and_then(|b| serde_json::from_slice(b).ok()).unwrap_or(Value::Null);
    let list = value.get("sources").unwrap_or(&value);
    list.as_array().into_iter().flatten().filter_map(|source| source["id"].as_str().map(String::from)).collect()
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("Could not locate the app data folder: {e}"))
}

fn read_files(dir: &std::path::Path) -> BTreeMap<String, Vec<u8>> {
    SHARED_FILES.iter().filter_map(|name| std::fs::read(dir.join(name)).ok().map(|bytes| (name.to_string(), bytes))).collect()
}

/// Hashes of shared files for the base: whole files by name, keyed files by `name#key` per entry.
fn file_hashes(files: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    let mut hashes = BTreeMap::new();
    for (name, bytes) in files {
        if KEYED_FILES.contains(&name.as_str()) {
            for (key, value) in keyed(Some(bytes)) {
                hashes.insert(format!("{name}#{key}"), hash(value.to_string().as_bytes()));
            }
        } else {
            hashes.insert(name.clone(), hash(bytes));
        }
    }
    hashes
}

fn keyed(bytes: Option<&Vec<u8>>) -> serde_json::Map<String, Value> {
    bytes.and_then(|b| serde_json::from_slice::<Value>(b).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// A keyed file, entry by entry: an entry takes the server's copy when this PC left it as it was at the
/// last sync. Returns the merged file when it differs from the local one.
fn merge_keyed(name: &str, local: Option<&Vec<u8>>, remote: Option<&Vec<u8>>, base: &BTreeMap<String, String>) -> Option<Vec<u8>> {
    let (mine, theirs) = (keyed(local), keyed(remote));
    let mut merged = mine.clone();
    let keys: BTreeSet<&String> = mine.keys().chain(theirs.keys()).collect();
    for key in keys {
        let base_hash = base.get(&format!("{name}#{key}")).cloned();
        let local_hash = mine.get(key).map(|v| hash(v.to_string().as_bytes()));
        let remote_hash = theirs.get(key).map(|v| hash(v.to_string().as_bytes()));
        if local_hash == base_hash && remote_hash != base_hash {
            match theirs.get(key) {
                Some(value) => { merged.insert(key.clone(), value.clone()); }
                None => { merged.remove(key); }
            }
        }
    }
    (merged != mine).then(|| serde_json::to_vec_pretty(&Value::Object(merged)).unwrap_or_default())
}

/// Same rule as for secrets: a file takes the server's copy when this PC left it unchanged since the last sync.
fn apply_remote_files(dir: &std::path::Path, base: &BTreeMap<String, String>, remote: &BTreeMap<String, Vec<u8>>) -> Result<usize, String> {
    let local = read_files(dir);
    let mut changed = 0;
    for name in KEYED_FILES {
        if let Some(bytes) = merge_keyed(name, local.get(*name), remote.get(*name), base) {
            std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the app data folder: {e}"))?;
            let path = dir.join(name);
            let temporary = path.with_extension("sync-tmp");
            std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path)).map_err(|e| format!("Could not save shared {name}: {e}"))?;
            changed += 1;
        }
    }
    for name in SHARED_FILES.iter().filter(|name| !KEYED_FILES.contains(name)) {
        let (local_hash, remote_hash, base_hash) = (local.get(*name).map(|v| hash(v)), remote.get(*name).map(|v| hash(v)), base.get(*name).cloned());
        if local_hash == base_hash && remote_hash != base_hash && local_hash != remote_hash {
            let path = dir.join(name);
            match remote.get(*name) {
                Some(bytes) => {
                    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the app data folder: {e}"))?;
                    let temporary = path.with_extension("sync-tmp");
                    std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path)).map_err(|e| format!("Could not save shared {name}: {e}"))?;
                }
                None => { let _ = std::fs::remove_file(&path); }
            }
            changed += 1;
        }
    }
    Ok(changed)
}

trait SecretStore {
    fn get(&self, service: &str, entry: &str) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, service: &str, entry: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, service: &str, entry: &str) -> Result<(), String>;
}

struct CredentialManager;

impl SecretStore for CredentialManager {
    fn get(&self, service: &str, entry: &str) -> Result<Option<Vec<u8>>, String> {
        let item = keyring::Entry::new(service, entry).map_err(|_| "Windows Credential Manager is unavailable.".to_string())?;
        match item.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(format!("Couldn't read a saved sign-in ({service}).")),
        }
    }
    fn set(&self, service: &str, entry: &str, value: &[u8]) -> Result<(), String> {
        keyring::Entry::new(service, entry)
            .and_then(|item| item.set_secret(value))
            .map_err(|_| format!("Couldn't save a shared sign-in ({service})."))
    }
    fn delete(&self, service: &str, entry: &str) -> Result<(), String> {
        match keyring::Entry::new(service, entry).and_then(|item| item.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(format!("Couldn't remove a shared sign-in ({service}).")),
        }
    }
}

fn read_local(store: &dyn SecretStore, slots: &BTreeSet<String>) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut found = BTreeMap::new();
    for slot in slots {
        if let Some((service, entry)) = parse_slot(slot) {
            if let Some(value) = store.get(service, &entry)? {
                found.insert(slot.clone(), value);
            }
        }
    }
    Ok(found)
}

/// Brings the server's changes into the local store: a slot takes the server's value when this PC left
/// it as it was at the last sync and the server changed it. Slots changed on both sides keep the local
/// value (it is pushed next). Returns how many slots changed.
fn apply_remote(store: &dyn SecretStore, slots: &BTreeSet<String>, base: &BTreeMap<String, String>, remote: &BTreeMap<String, Vec<u8>>) -> Result<usize, String> {
    let local = read_local(store, slots)?;
    let mut changed = 0;
    for slot in slots {
        let Some((service, entry)) = parse_slot(slot) else { continue };
        let local_hash = local.get(slot).map(|v| hash(v));
        let remote_hash = remote.get(slot).map(|v| hash(v));
        let base_hash = base.get(slot).cloned();
        if local_hash == base_hash && remote_hash != base_hash && local_hash != remote_hash {
            match remote.get(slot) {
                Some(value) => store.set(service, &entry, value)?,
                None => store.delete(service, &entry)?,
            }
            changed += 1;
        }
    }
    Ok(changed)
}

fn hashes(secrets: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    secrets.iter().map(|(slot, value)| (slot.clone(), hash(value))).collect()
}

// ---- Firestore ----------------------------------------------------------------------------------------

fn doc_name(key: &ServiceAccount, id: &str) -> String {
    format!("projects/{}/databases/(default)/documents/{COLLECTION}/{id}", key.project_id)
}

/// GET a team document: its plain fields and update time, or None if it doesn't exist.
async fn get_doc(key: &ServiceAccount, id: &str) -> Result<Option<(serde_json::Map<String, Value>, String)>, String> {
    let token = review::access_token(key).await?;
    let url = format!("{}/{COLLECTION}/{id}", review::documents_url(key));
    let response = review::client(review::REQUEST_TIMEOUT)?.get(&url).bearer_auth(token).send().await.map_err(|e| format!("Couldn't reach the cloud: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("The cloud refused the request: {}", body["error"]["message"].as_str().unwrap_or(status.as_str())));
    }
    Ok(Some((review::plain_fields(&body["fields"]), body["updateTime"].as_str().unwrap_or_default().to_string())))
}

/// Runs a Firestore commit. Ok(false) means a precondition failed (someone else wrote first).
async fn commit(key: &ServiceAccount, writes: Vec<Value>) -> Result<bool, String> {
    let token = review::access_token(key).await?;
    let url = format!("{}:commit", review::documents_url(key));
    let response = review::client(review::REQUEST_TIMEOUT)?
        .post(&url)
        .bearer_auth(token)
        .json(&json!({ "writes": writes }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the cloud: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(true);
    }
    let reason = body["error"]["status"].as_str().unwrap_or_default();
    if matches!(reason, "FAILED_PRECONDITION" | "ABORTED" | "ALREADY_EXISTS") || status == reqwest::StatusCode::CONFLICT {
        return Ok(false);
    }
    Err(format!("The cloud refused the change: {}", body["error"]["message"].as_str().unwrap_or(status.as_str())))
}

fn update(key: &ServiceAccount, id: &str, fields: Value) -> Value {
    json!({ "update": { "name": doc_name(key, id), "fields": review::fields_of(fields.as_object().expect("fields are an object")) } })
}

fn machine() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this PC".into())
}

// ---- Commands -----------------------------------------------------------------------------------------

#[tauri::command]
pub fn team_sync_status(app: tauri::AppHandle) -> Result<TeamStatus, String> {
    Ok(TeamStatus {
        review_connected: review::require_key().is_ok(),
        enabled: load_team_key()?.is_some(),
        last_synced_at: read_state(&data_dir(&app)?)?.last_synced_at,
    })
}

/// Turns sharing on with the team passphrase. The first PC creates the team; any later PC must type
/// the same passphrase, which is checked against the encrypted check value. Returns true if this PC
/// created the team.
#[tauri::command]
pub async fn team_sync_enable(app: tauri::AppHandle, passphrase: String) -> Result<bool, String> {
    if passphrase.chars().count() < MIN_PASSPHRASE || passphrase.len() > 500 {
        return Err(format!("Use a team passphrase of at least {MIN_PASSPHRASE} characters."));
    }
    let account = review::require_key().map_err(|_| "Connect Partner review first: sharing uses the same cloud project.".to_string())?;
    let _running = RUNNING.lock().await;
    let (key, created) = match get_doc(&account, "meta").await? {
        Some((meta, _)) => {
            let salt = STANDARD.decode(meta.get("salt").and_then(Value::as_str).unwrap_or_default()).map_err(|_| "The team settings in the cloud are damaged.")?;
            let iterations = meta.get("iterations").and_then(Value::as_u64).unwrap_or(ITERATIONS as u64) as u32;
            let key = tauri::async_runtime::spawn_blocking(move || crate::backup::key(&passphrase, &salt, iterations)).await.map_err(|_| "Could not derive the team key.")?;
            let nonce = meta.get("checkNonce").and_then(Value::as_str).unwrap_or_default();
            let check = meta.get("check").and_then(Value::as_str).unwrap_or_default();
            if open(&key, nonce, check).ok().as_deref() != Some(CHECK_TEXT) {
                return Err("That isn't the team passphrase. Use the one typed on the other PC.".into());
            }
            (key, false)
        }
        None => {
            let salt = crate::backup::random::<16>()?;
            let key = tauri::async_runtime::spawn_blocking(move || crate::backup::key(&passphrase, &salt, ITERATIONS)).await.map_err(|_| "Could not derive the team key.")?;
            let (nonce, check) = seal(&key, CHECK_TEXT)?;
            let mut write = update(&account, "meta", json!({ "salt": STANDARD.encode(salt), "iterations": ITERATIONS, "checkNonce": nonce, "check": check, "createdAt": review::now_ms(), "createdBy": machine() }));
            write["currentDocument"] = json!({ "exists": false });
            if !commit(&account, vec![write]).await? {
                return Err("The other PC turned sharing on at the same moment. Try again with its passphrase.".into());
            }
            (key, true)
        }
    };
    key_entry()?.set_secret(&key).map_err(|_| "Couldn't save the team key in Windows Credential Manager.")?;
    // A fresh start: the first sync merges this PC's accounts with what is already shared.
    write_state(&data_dir(&app)?, &State::default())?;
    *SEEN.lock().map_err(|_| "Sync state is unavailable.")? = None;
    Ok(created)
}

/// Stops sharing on this PC. Nothing is deleted locally or in the cloud.
#[tauri::command]
pub fn team_sync_disable(app: tauri::AppHandle) -> Result<(), String> {
    match key_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("Couldn't remove the team key from Windows Credential Manager.".into()),
    }
    *SEEN.lock().map_err(|_| "Sync state is unavailable.")? = None;
    match std::fs::remove_file(data_dir(&app)?.join(STATE_FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't clear the sync state: {e}")),
    }
}

/// Step 1 of a sync: reads the marker (and the payload only if it changed), brings the other PC's
/// sign-ins into Credential Manager, and returns the shared workspace for the app to merge.
#[tauri::command]
pub async fn team_sync_fetch(app: tauri::AppHandle, sources: tauri::State<'_, crate::video_sources::SourcesLock>, account_ids: Vec<String>) -> Result<Fetched, String> {
    let key = require_team_key()?;
    let account = review::require_key()?;
    let _running = RUNNING.lock().await;
    let pc = Pc { dir: data_dir(&app)?, store: &CredentialManager, seen: &SEEN, files_lock: &sources.0 };
    fetch(&pc, &key, &account, account_ids).await
}

/// This PC as the sync sees it: its data folder, its secret store, what the last fetch saw, and the
/// lock that guards the shared files. Tests run two of these side by side.
struct Pc<'a, S: SecretStore> {
    dir: PathBuf,
    store: &'a S,
    seen: &'a Mutex<Option<Seen>>,
    files_lock: &'a Mutex<()>,
}

async fn fetch<S: SecretStore>(pc: &Pc<'_, S>, key: &[u8; 32], account: &ServiceAccount, account_ids: Vec<String>) -> Result<Fetched, String> {
    let (key, account) = (*key, account);
    let state = read_state(&pc.dir)?;
    let marker = get_doc(account, "marker").await?;
    let remote_rev = marker.as_ref().and_then(|(fields, _)| fields.get("rev").and_then(Value::as_u64)).unwrap_or(0);
    let marker_time = marker.map(|(_, time)| time);
    let mut seen = Seen { rev: remote_rev, marker_time, remote_workspace: state.base.clone(), remote_hashes: None, remote_file_hashes: None };
    let mut received = 0;
    if remote_rev == 0 {
        seen.remote_workspace = None;
        seen.remote_hashes = Some(BTreeMap::new());
        seen.remote_file_hashes = Some(BTreeMap::new());
    } else if remote_rev != state.rev {
        let (data, _) = get_doc(account, "data").await?.ok_or("The shared data is missing from the cloud.")?;
        let plain = open(&key, data.get("nonce").and_then(Value::as_str).unwrap_or_default(), data.get("data").and_then(Value::as_str).unwrap_or_default())?;
        let payload: Payload = serde_json::from_slice(&plain).map_err(|_| "The shared data is damaged.")?;
        let remote: BTreeMap<String, Vec<u8>> = payload.secrets.iter()
            .filter(|(slot, _)| parse_slot(slot).is_some())
            .filter_map(|(slot, value)| STANDARD.decode(value).ok().map(|bytes| (slot.clone(), bytes)))
            .collect();
        let remote_files: BTreeMap<String, Vec<u8>> = payload.files.iter()
            .filter(|(name, _)| SHARED_FILES.contains(&name.as_str()))
            .filter_map(|(name, value)| STANDARD.decode(value).ok().map(|bytes| (name.clone(), bytes)))
            .collect();
        let dir = pc.dir.clone();
        received += {
            let _guard = pc.files_lock.lock().map_err(|_| "Video sources are unavailable.")?;
            apply_remote_files(&dir, &state.file_hashes, &remote_files)?
        };
        let local_files = read_files(&dir);
        let source_list: BTreeSet<String> = source_ids(local_files.get(SHARED_FILES[0]).map(Vec::as_slice)).into_iter().chain(source_ids(remote_files.get(SHARED_FILES[0]).map(Vec::as_slice))).collect();
        let ids: BTreeSet<String> = account_ids.iter().cloned().chain(accounts_in(Some(&payload.workspace))).chain(accounts_in(state.base.as_ref())).collect();
        let mut slots = candidate_slots(&ids, &source_list);
        slots.extend(remote.keys().cloned());
        slots.extend(state.secret_hashes.keys().cloned());
        received += apply_remote(pc.store, &slots, &state.secret_hashes, &remote)?;
        seen.remote_hashes = Some(hashes(&remote));
        seen.remote_file_hashes = Some(file_hashes(&remote_files));
        seen.remote_workspace = Some(payload.workspace);
    }
    if let Some(workspace) = seen.remote_workspace.as_ref() {
        download_images(pc, &key, account, workspace).await;
    }
    let fetched = Fetched { rev: remote_rev, remote: seen.remote_workspace.clone(), base: state.base.clone(), secrets_received: received };
    *pc.seen.lock().map_err(|_| "Sync state is unavailable.")? = Some(seen);
    Ok(fetched)
}

// ---- Brand pictures -------------------------------------------------------------------------------------

fn image_doc(name: &str) -> String {
    format!("img-{}", name.replace('.', "-"))
}

/// Uploads the pictures this workspace names that aren't in the cloud yet, each as its own encrypted
/// document. Pictures never change (their name is their hash), so each is written once.
async fn upload_images<S: SecretStore>(pc: &Pc<'_, S>, key: &[u8; 32], account: &ServiceAccount, workspace: &Value, state: &mut State) -> Result<(), String> {
    let missing: Vec<String> = brand_images::refs_in(workspace).into_iter().filter(|name| !state.images_in_cloud.contains(name)).collect();
    let mut uploaded = false;
    for name in missing {
        let Some(bytes) = brand_images::read(&pc.dir, &name) else { continue };
        let (nonce, data) = seal(key, &bytes)?;
        if commit(account, vec![update(account, &image_doc(&name), json!({ "nonce": nonce, "data": data }))]).await? {
            state.images_in_cloud.insert(name);
            uploaded = true;
        }
    }
    if uploaded {
        write_state(&pc.dir, state)?;
    }
    Ok(())
}

/// Downloads the pictures this workspace names that this PC doesn't have. A picture that can't be
/// fetched now is tried again on the next sync; it never stops the sync.
async fn download_images<S: SecretStore>(pc: &Pc<'_, S>, key: &[u8; 32], account: &ServiceAccount, workspace: &Value) {
    let missing: Vec<String> = brand_images::refs_in(workspace).into_iter().filter(|name| brand_images::read(&pc.dir, name).is_none()).collect();
    let mut arrived = Vec::new();
    for name in missing {
        let Ok(Some((doc, _))) = get_doc(account, &image_doc(&name)).await else { continue };
        let Ok(bytes) = open(key, doc.get("nonce").and_then(Value::as_str).unwrap_or_default(), doc.get("data").and_then(Value::as_str).unwrap_or_default()) else { continue };
        if brand_images::name_of(&bytes).as_deref() == Some(name.as_str()) && brand_images::save_bytes(&pc.dir, &bytes).is_ok() {
            arrived.push(name);
        }
    }
    if !arrived.is_empty() {
        if let Ok(mut state) = read_state(&pc.dir) {
            state.images_in_cloud.extend(arrived);
            let _ = write_state(&pc.dir, &state);
        }
    }
}

/// Step 2 of a sync: uploads the merged shared workspace and this PC's sign-ins if anything differs from
/// the server, in one commit that fails if the other PC wrote since the fetch (then fetch again).
#[tauri::command]
pub async fn team_sync_push(app: tauri::AppHandle, workspace: Value, account_ids: Vec<String>) -> Result<Pushed, String> {
    let key = require_team_key()?;
    let account = review::require_key()?;
    if !workspace.is_object() {
        return Err("The shared workspace isn't valid.".into());
    }
    let _running = RUNNING.lock().await;
    let lock = Mutex::new(());
    let pc = Pc { dir: data_dir(&app)?, store: &CredentialManager, seen: &SEEN, files_lock: &lock };
    push(&pc, &key, &account, workspace, account_ids).await
}

async fn push<S: SecretStore>(pc: &Pc<'_, S>, key: &[u8; 32], account: &ServiceAccount, workspace: Value, account_ids: Vec<String>) -> Result<Pushed, String> {
    let (key, account) = (*key, account);
    let Some(seen) = pc.seen.lock().map_err(|_| "Sync state is unavailable.")?.take() else {
        return Ok(Pushed { rev: 0, pushed: false, conflict: true });
    };
    let mut state = read_state(&pc.dir)?;
    // Pictures go up first, so the other PC finds every picture the new workspace names.
    upload_images(pc, &key, account, &workspace, &mut state).await?;
    let ids: BTreeSet<String> = account_ids.into_iter().chain(accounts_in(Some(&workspace))).collect();
    // Remote changes were applied during the fetch, so this PC now holds the merged secrets and files.
    // Slots of accounts and sources that no longer exist are left out of the upload.
    let files = read_files(&pc.dir);
    let file_hashes = file_hashes(&files);
    let local = read_local(pc.store, &candidate_slots(&ids, &source_ids(files.get(SHARED_FILES[0]).map(Vec::as_slice))))?;
    let local_hashes = hashes(&local);
    let remote_hashes = seen.remote_hashes.clone().unwrap_or_else(|| state.secret_hashes.clone());
    let remote_file_hashes = seen.remote_file_hashes.clone().unwrap_or_else(|| state.file_hashes.clone());
    let same = seen.remote_workspace.as_ref() == Some(&workspace) && local_hashes == remote_hashes && file_hashes == remote_file_hashes;
    if same {
        state.rev = seen.rev;
        state.base = Some(workspace);
        state.secret_hashes = local_hashes;
        state.file_hashes = file_hashes;
        state.last_synced_at = review::now_ms();
        write_state(&pc.dir, &state)?;
        return Ok(Pushed { rev: seen.rev, pushed: false, conflict: false });
    }
    let payload = Payload {
        workspace: workspace.clone(),
        secrets: local.iter().map(|(slot, value)| (slot.clone(), STANDARD.encode(value))).collect(),
        files: files.iter().map(|(name, bytes)| (name.clone(), STANDARD.encode(bytes))).collect(),
    };
    let plain = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    if plain.len() > MAX_PAYLOAD {
        return Err("There is too much shared data to upload.".into());
    }
    let (nonce, data) = seal(&key, &plain)?;
    let rev = seen.rev + 1;
    let now = review::now_ms();
    let mut marker = update(account, "marker", json!({ "rev": rev, "updatedAt": now, "updatedBy": machine() }));
    marker["currentDocument"] = match &seen.marker_time {
        Some(time) => json!({ "updateTime": time }),
        None => json!({ "exists": false }),
    };
    let writes = vec![update(account, "data", json!({ "rev": rev, "nonce": nonce, "data": data })), marker];
    if !commit(account, writes).await? {
        return Ok(Pushed { rev: seen.rev, pushed: false, conflict: true });
    }
    state.rev = rev;
    state.base = Some(workspace);
    state.secret_hashes = local_hashes;
    state.file_hashes = file_hashes;
    state.last_synced_at = now;
    write_state(&pc.dir, &state)?;
    Ok(Pushed { rev, pushed: true, conflict: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Memory(RefCell<BTreeMap<String, Vec<u8>>>);
    impl SecretStore for Memory {
        fn get(&self, service: &str, entry: &str) -> Result<Option<Vec<u8>>, String> { Ok(self.0.borrow().get(&format!("{service}|{entry}")).cloned()) }
        fn set(&self, service: &str, entry: &str, value: &[u8]) -> Result<(), String> { self.0.borrow_mut().insert(format!("{service}|{entry}"), value.to_vec()); Ok(()) }
        fn delete(&self, service: &str, entry: &str) -> Result<(), String> { self.0.borrow_mut().remove(&format!("{service}|{entry}")); Ok(()) }
    }

    const PW: &str = "social-manager-account-password";

    fn slot(entry: &str) -> String { format!("{PW}|{entry}") }

    #[test]
    fn candidate_slots_cover_every_shared_service_per_account() {
        let slots = candidate_slots(&["acc1".to_string()].into(), &["ab12".to_string()].into());
        assert!(slots.contains("social-manager-video-source|ab12"));
        assert!(slots.contains(&slot("acc1")));
        assert!(slots.contains("social-manager-instagram-page|primary"));
        assert!(slots.contains("social-manager-instagram-page|acc1"));
        assert!(slots.contains("social-manager-developer-app|meta"));
        assert!(slots.contains("social-manager-developer-app|tiktok-production"));
        assert!(slots.contains("social-manager-account-password|developer-tiktok"));
        assert!(!slots.contains("social-manager-developer-app|acc1"));
        assert!(!slots.iter().any(|s| s.starts_with("social-manager-partner-review") || s.starts_with(KEY_SERVICE)));
    }

    #[test]
    fn parse_slot_rejects_unshared_services_and_bad_entries() {
        assert!(parse_slot(&slot("abc-1")).is_some());
        assert!(parse_slot("social-manager-partner-review|service-account").is_none());
        assert!(parse_slot(&slot("../x")).is_none());
        assert!(parse_slot("no-separator").is_none());
    }

    #[test]
    fn remote_changes_land_only_where_this_pc_did_not_change_anything() {
        let store = Memory::default();
        store.set(PW, "same", b"old").unwrap();
        store.set(PW, "mine", b"edited here").unwrap();
        store.set(PW, "gone", b"old").unwrap();
        let base: BTreeMap<String, String> = [("same", b"old".as_slice()), ("mine", b"old"), ("gone", b"old")].iter().map(|(k, v)| (slot(k), hash(v))).collect();
        let remote: BTreeMap<String, Vec<u8>> = [(slot("same"), b"new".to_vec()), (slot("mine"), b"their edit".to_vec()), (slot("fresh"), b"added there".to_vec())].into();
        let slots: BTreeSet<String> = ["same", "mine", "gone", "fresh"].iter().map(|k| slot(k)).collect();
        let changed = apply_remote(&store, &slots, &base, &remote).unwrap();
        assert_eq!(changed, 3);
        assert_eq!(store.get(PW, "same").unwrap().as_deref(), Some(b"new".as_slice()));
        assert_eq!(store.get(PW, "mine").unwrap().as_deref(), Some(b"edited here".as_slice()), "local edit wins and is pushed next");
        assert_eq!(store.get(PW, "gone").unwrap(), None, "deleted on the other PC");
        assert_eq!(store.get(PW, "fresh").unwrap().as_deref(), Some(b"added there".as_slice()));
    }

    #[test]
    fn first_sync_keeps_local_secrets_and_adds_remote_ones() {
        let store = Memory::default();
        store.set(PW, "local", b"a").unwrap();
        let remote: BTreeMap<String, Vec<u8>> = [(slot("remote"), b"b".to_vec())].into();
        let slots: BTreeSet<String> = [slot("local"), slot("remote")].into();
        apply_remote(&store, &slots, &BTreeMap::new(), &remote).unwrap();
        assert_eq!(store.get(PW, "local").unwrap().as_deref(), Some(b"a".as_slice()));
        assert_eq!(store.get(PW, "remote").unwrap().as_deref(), Some(b"b".as_slice()));
    }

    #[test]
    fn developer_sign_ins_own_password_slots() {
        let workspace = json!({ "accounts": [{ "id": "a1" }], "developerLogins": { "tiktok": { "email": "x@y.z" } } });
        let ids: Vec<String> = accounts_in(Some(&workspace)).collect();
        assert_eq!(ids, ["a1", "developer-tiktok"]);
    }

    #[test]
    fn brand_sign_ins_merge_brand_by_brand() {
        let name = crate::browser_sessions::SESSIONS_FILE;
        let base_file = br#"{"b1":{"savedAt":1},"b2":{"savedAt":1}}"#.to_vec();
        let base = file_hashes(&[(name.to_string(), base_file)].into());
        // This PC signed in again on b1; the other PC did on b2 and added b3.
        let local = br#"{"b1":{"savedAt":5},"b2":{"savedAt":1}}"#.to_vec();
        let remote = br#"{"b1":{"savedAt":1},"b2":{"savedAt":7},"b3":{"savedAt":8}}"#.to_vec();
        let merged: Value = serde_json::from_slice(&merge_keyed(name, Some(&local), Some(&remote), &base).unwrap()).unwrap();
        assert_eq!(merged, json!({ "b1": { "savedAt": 5 }, "b2": { "savedAt": 7 }, "b3": { "savedAt": 8 } }));
        assert!(merge_keyed(name, Some(&local), Some(&local), &base).is_none(), "nothing new");
    }

    #[test]
    fn source_ids_read_both_file_shapes() {
        assert_eq!(source_ids(Some(br#"{"active":"a1","sources":[{"id":"a1"},{"id":"b2"}]}"#)), ["a1".to_string(), "b2".to_string()].into());
        assert_eq!(source_ids(Some(br#"[{"id":"c3"}]"#)), ["c3".to_string()].into());
        assert!(source_ids(None).is_empty());
    }

    #[test]
    fn shared_files_follow_the_same_three_way_rule() {
        let dir = tempfile::tempdir().unwrap();
        let name = SHARED_FILES[0];
        std::fs::write(dir.path().join(name), b"old").unwrap();
        let base: BTreeMap<String, String> = [(name.to_string(), hash(b"old"))].into();
        let remote: BTreeMap<String, Vec<u8>> = [(name.to_string(), b"new".to_vec())].into();
        assert_eq!(apply_remote_files(dir.path(), &base, &remote).unwrap(), 1);
        assert_eq!(std::fs::read(dir.path().join(name)).unwrap(), b"new");
        std::fs::write(dir.path().join(name), b"edited here").unwrap();
        assert_eq!(apply_remote_files(dir.path(), &base, &remote).unwrap(), 0, "a local edit is kept and pushed");
    }

    /// Live round trip against the real Firebase project, in the `team-test` collection, with the
    /// review key from this PC's Credential Manager: `cargo test live_firestore -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_firestore_round_trip_and_conflict() {
        let account = review::require_key().expect("Partner review is connected on this PC");
        let delete = |id: &str| json!({ "delete": doc_name(&account, id) });
        assert!(commit(&account, vec![delete("marker"), delete("data")]).await.unwrap());
        let key = crate::backup::key("live test passphrase", b"0123456789abcdef", 1000);
        let (nonce, data) = seal(&key, b"{\"workspace\":{},\"secrets\":{}}").unwrap();
        let mut first = update(&account, "marker", json!({ "rev": 1 }));
        first["currentDocument"] = json!({ "exists": false });
        assert!(commit(&account, vec![update(&account, "data", json!({ "rev": 1, "nonce": nonce, "data": data })), first.clone()]).await.unwrap());
        assert!(!commit(&account, vec![first]).await.unwrap(), "a second create of the marker must fail");
        let (marker, time) = get_doc(&account, "marker").await.unwrap().unwrap();
        assert_eq!(marker.get("rev").and_then(Value::as_u64), Some(1));
        let (stored, _) = get_doc(&account, "data").await.unwrap().unwrap();
        assert!(open(&key, stored["nonce"].as_str().unwrap(), stored["data"].as_str().unwrap()).is_ok());
        let mut next = update(&account, "marker", json!({ "rev": 2 }));
        next["currentDocument"] = json!({ "updateTime": time });
        assert!(commit(&account, vec![next.clone()]).await.unwrap());
        assert!(!commit(&account, vec![next]).await.unwrap(), "a write based on an old marker must fail");
        assert!(commit(&account, vec![delete("marker"), delete("data")]).await.unwrap());
        assert!(get_doc(&account, "marker").await.unwrap().is_none());
    }

    /// Two PCs sharing through the real Firebase project (`team-test` collection, the review key from
    /// this PC's Credential Manager): a brand with its profile password, a developer sign-in and the
    /// Grok key made on one PC show up on the other; edits flow back; a stale write is refused.
    /// `cargo test two_pcs -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn two_pcs_share_everything_through_the_cloud() {
        let account = review::require_key().expect("Partner review is connected on this PC");
        let wipe = || commit(&account, vec![json!({ "delete": doc_name(&account, "marker") }), json!({ "delete": doc_name(&account, "data") })]);
        assert!(wipe().await.unwrap());
        let key = crate::backup::key("two pc test passphrase", b"fedcba9876543210", 1000);
        let (dir_a, dir_b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (store_a, store_b) = (Memory::default(), Memory::default());
        let (seen_a, seen_b, lock) = (Mutex::new(None), Mutex::new(None), Mutex::new(()));
        let a = Pc { dir: dir_a.path().to_path_buf(), store: &store_a, seen: &seen_a, files_lock: &lock };
        let b = Pc { dir: dir_b.path().to_path_buf(), store: &store_b, seen: &seen_b, files_lock: &lock };

        // PC A makes a brand with a profile, a developer sign-in and a Grok video source.
        store_a.set(PW, "acc1", b"profile-pass").unwrap();
        store_a.set(PW, "developer-tiktok", b"dev-pass").unwrap();
        store_a.set("social-manager-developer-app", "tiktok-production", br#"{"id":"prod"}"#).unwrap();
        store_a.set(VIDEO_SOURCE_SERVICE, "ab12", b"xai-key").unwrap();
        std::fs::write(dir_a.path().join(SHARED_FILES[0]), br#"{"active":"ab12","sources":[{"id":"ab12","name":"Grok","provider":"grok"}]}"#).unwrap();
        let picture = brand_images::save_bytes(dir_a.path(), &[0xFF, 0xD8, 0xFF, 0xE0, 7, 7, 7]).unwrap();
        let workspace = json!({ "businessName": "Soft Wings", "brands": [{ "id": "b1", "name": "Cooking", "image": { "file": picture } }], "accounts": [{ "id": "acc1", "brandId": "b1" }], "developerLogins": { "tiktok": { "email": "dev@x.com" } } });
        assert!(fetch(&a, &key, &account, vec!["acc1".into()]).await.unwrap().remote.is_none());
        assert!(push(&a, &key, &account, workspace.clone(), vec!["acc1".into()]).await.unwrap().pushed);

        // PC B, empty, joins and gets all of it.
        let got = fetch(&b, &key, &account, vec![]).await.unwrap();
        assert_eq!(got.remote.as_ref(), Some(&workspace));
        assert_eq!(store_b.get(PW, "acc1").unwrap().as_deref(), Some(b"profile-pass".as_slice()));
        assert_eq!(store_b.get(PW, "developer-tiktok").unwrap().as_deref(), Some(b"dev-pass".as_slice()));
        assert_eq!(store_b.get("social-manager-developer-app", "tiktok-production").unwrap().as_deref(), Some(br#"{"id":"prod"}"#.as_slice()));
        assert_eq!(store_b.get(VIDEO_SOURCE_SERVICE, "ab12").unwrap().as_deref(), Some(b"xai-key".as_slice()));
        assert!(std::fs::read(dir_b.path().join(SHARED_FILES[0])).unwrap().starts_with(br#"{"active":"ab12""#));
        assert!(brand_images::read(dir_b.path(), &picture).is_some(), "the brand picture came across");
        assert!(!push(&b, &key, &account, workspace.clone(), vec!["acc1".into()]).await.unwrap().pushed, "nothing new to upload");

        // PC B changes the password; PC A picks it up.
        store_b.set(PW, "acc1", b"changed-on-b").unwrap();
        fetch(&b, &key, &account, vec!["acc1".into()]).await.unwrap();
        assert!(push(&b, &key, &account, workspace.clone(), vec!["acc1".into()]).await.unwrap().pushed);
        fetch(&a, &key, &account, vec!["acc1".into()]).await.unwrap();
        assert_eq!(store_a.get(PW, "acc1").unwrap().as_deref(), Some(b"changed-on-b".as_slice()));
        assert!(!push(&a, &key, &account, workspace.clone(), vec!["acc1".into()]).await.unwrap().pushed);

        // A brand signed in on each PC at once: both sign-ins end up on both PCs.
        let sessions = crate::browser_sessions::SESSIONS_FILE;
        std::fs::write(dir_a.path().join(sessions), br#"{"b1":{"savedAt":10,"savedBy":"A","cookies":[]}}"#).unwrap();
        fetch(&a, &key, &account, vec![]).await.unwrap();
        assert!(push(&a, &key, &account, workspace.clone(), vec![]).await.unwrap().pushed);
        std::fs::write(dir_b.path().join(sessions), br#"{"b2":{"savedAt":11,"savedBy":"B","cookies":[]}}"#).unwrap();
        fetch(&b, &key, &account, vec![]).await.unwrap();
        assert!(push(&b, &key, &account, workspace.clone(), vec![]).await.unwrap().pushed);
        fetch(&a, &key, &account, vec![]).await.unwrap();
        let on_a: Value = serde_json::from_slice(&std::fs::read(dir_a.path().join(sessions)).unwrap()).unwrap();
        let on_b: Value = serde_json::from_slice(&std::fs::read(dir_b.path().join(sessions)).unwrap()).unwrap();
        assert!(on_a.get("b1").is_some() && on_a.get("b2").is_some(), "A has both brands' sign-ins: {on_a}");
        assert!(on_b.get("b1").is_some() && on_b.get("b2").is_some(), "B has both brands' sign-ins: {on_b}");
        assert!(!push(&a, &key, &account, workspace.clone(), vec![]).await.unwrap().pushed);

        // Both fetch, B writes first, A's write is refused as a conflict.
        fetch(&a, &key, &account, vec![]).await.unwrap();
        fetch(&b, &key, &account, vec![]).await.unwrap();
        let mut renamed = workspace.clone();
        renamed["businessName"] = json!("Renamed on B");
        assert!(push(&b, &key, &account, renamed, vec![]).await.unwrap().pushed);
        let mut other = workspace.clone();
        other["businessName"] = json!("Renamed on A");
        assert!(push(&a, &key, &account, other, vec![]).await.unwrap().conflict);
        assert_eq!(fetch(&a, &key, &account, vec![]).await.unwrap().remote.unwrap()["businessName"], "Renamed on B");

        assert!(wipe().await.unwrap());
        assert!(commit(&account, vec![json!({ "delete": doc_name(&account, &image_doc(&picture)) })]).await.unwrap());
    }

    #[test]
    fn sealed_data_opens_only_with_the_same_key() {
        let key = crate::backup::key("correct horse", b"0123456789abcdef", 1000);
        let (nonce, data) = seal(&key, CHECK_TEXT).unwrap();
        assert_eq!(open(&key, &nonce, &data).unwrap(), CHECK_TEXT);
        let other = crate::backup::key("wrong horse!", b"0123456789abcdef", 1000);
        assert!(open(&other, &nonce, &data).is_err());
    }
}
