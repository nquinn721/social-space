//! Named video generation sources. Each source has a provider (Kling or Grok)
//! and its own API key. Names, verification results and the active source live
//! in `video-sources.json`; keys live only in Windows Credential Manager, one
//! entry per source. All video generation uses the active source unless a
//! request names another.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const SOURCES_FILE: &str = "video-sources.json";
const MAX_SOURCES: usize = 50;
const MAX_NAME_CHARS: usize = 60;
const MAX_KEY_BYTES: usize = 2_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Kling's free usage endpoint wants a time window; 90 days covers active packs.
const USAGE_WINDOW_MS: u64 = 90 * 24 * 60 * 60 * 1000;

#[cfg(windows)]
const KEYRING_SERVICE: &str = "social-manager-video-source";
/// Where the single Kling key lived before video sources existed.
#[cfg(windows)]
const LEGACY_KLING_SERVICE: &str = "com.socialmanager.desktop.kling";
#[cfg(windows)]
const LEGACY_KLING_ACCOUNT: &str = "api-key";
const LEGACY_SOURCE_NAME: &str = "Kling";

#[derive(Default)]
pub struct SourcesLock(pub(crate) Mutex<()>);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VideoProvider {
    Kling,
    Grok,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    Unchecked,
    Verified,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSource {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) provider: VideoProvider,
    status: SourceStatus,
    /// Unix milliseconds of the last successful check with the provider.
    checked_at: Option<u64>,
    /// Remaining units across the provider's active resource packs, when known.
    credits_remaining: Option<f64>,
    /// A short note from the last check, such as an account warning.
    detail: Option<String>,
}

/// What the app shows and stores: every source, and the one video generation uses.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesState {
    active: Option<String>,
    sources: Vec<VideoSource>,
}

/// Files written before the active source existed hold just the list.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredSources {
    State(SourcesState),
    List(Vec<VideoSource>),
}

impl SourcesState {
    /// Keeps `active` pointing at a usable source, preferring verified ones.
    fn repair_active(&mut self) {
        let usable = |id: &String| self.sources.iter().any(|source| &source.id == id && source.status != SourceStatus::Rejected);
        if self.active.as_ref().is_some_and(usable) {
            return;
        }
        self.active = self
            .sources
            .iter()
            .find(|source| source.status == SourceStatus::Verified)
            .or_else(|| self.sources.iter().find(|source| source.status != SourceStatus::Rejected))
            .map(|source| source.id.clone());
    }
}

/// What a provider said about a key.
#[derive(Debug, PartialEq)]
enum Verdict {
    Verified { credits: Option<f64>, detail: Option<String> },
    Rejected(String),
    /// The provider could not be asked; the key's status is unknown.
    Unavailable(String),
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create a source ID.")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(format!("Give the source a name of up to {MAX_NAME_CHARS} characters."));
    }
    Ok(name.to_string())
}

fn clean_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() || key.len() > MAX_KEY_BYTES || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Enter a valid API key.".into());
    }
    Ok(key.to_string())
}

fn ensure_unique_name(sources: &[VideoSource], name: &str, except: Option<&str>) -> Result<(), String> {
    if sources
        .iter()
        .any(|source| Some(source.id.as_str()) != except && source.name.eq_ignore_ascii_case(name))
    {
        return Err("Another video source already has that name.".into());
    }
    Ok(())
}

// ---------- storage ----------

fn sources_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(SOURCES_FILE))
        .map_err(|_| "Could not locate the app data folder.".into())
}

fn read_sources(path: &Path) -> Result<Option<SourcesState>, String> {
    match fs::read(path) {
        Ok(contents) => match serde_json::from_slice(&contents) {
            Ok(StoredSources::State(state)) => Ok(Some(state)),
            Ok(StoredSources::List(sources)) => {
                let mut state = SourcesState { active: None, sources };
                state.repair_active();
                Ok(Some(state))
            }
            Err(_) => Err("Could not read your video sources.".into()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not open your video sources.".into()),
    }
}

fn write_sources(path: &Path, state: &SourcesState) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid video sources path.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the app data folder.")?;
    let contents = serde_json::to_vec_pretty(state).map_err(|_| "Could not encode video sources.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Could not save video sources.")?;
    temporary
        .write_all(&contents)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Could not save video sources.")?;
    temporary
        .persist(path)
        .map_err(|_| "Could not save video sources.")?;
    Ok(())
}

fn with_sources<T>(
    app: &AppHandle,
    lock: &SourcesLock,
    change: impl FnOnce(&mut SourcesState) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = lock.0.lock().map_err(|_| "Video sources are unavailable.")?;
    let path = sources_path(app)?;
    let mut state = load_or_migrate(&path)?;
    let result = change(&mut state)?;
    state.repair_active();
    write_sources(&path, &state)?;
    Ok(result)
}

/// The first time sources are read, the old single Kling key becomes a source.
fn load_or_migrate(path: &Path) -> Result<SourcesState, String> {
    if let Some(state) = read_sources(path)? {
        return Ok(state);
    }
    let mut state = SourcesState::default();
    if let Some(key) = take_legacy_kling_key()? {
        let source = VideoSource {
            id: new_id()?,
            name: LEGACY_SOURCE_NAME.into(),
            provider: VideoProvider::Kling,
            status: SourceStatus::Unchecked,
            checked_at: None,
            credits_remaining: None,
            detail: None,
        };
        store_key(&source.id, &key)?;
        state.sources.push(source);
        state.repair_active();
        write_sources(path, &state)?;
        delete_legacy_kling_key();
    }
    Ok(state)
}

// ---------- credential manager ----------

#[cfg(windows)]
fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Unknown video source.".into());
    }
    keyring::Entry::new(KEYRING_SERVICE, id).map_err(|_| "Windows Credential Manager is unavailable.".into())
}

#[cfg(windows)]
fn store_key(id: &str, key: &str) -> Result<(), String> {
    key_entry(id)?
        .set_password(key)
        .map_err(|_| "Could not save the key in Windows Credential Manager.".into())
}

/// Every video source with its API key, for the plain-text accounts export.
pub(crate) fn export_keys(app: &AppHandle, lock: &SourcesLock) -> Result<Vec<(String, VideoProvider, Option<String>)>, String> {
    let state = {
        let _guard = lock.0.lock().map_err(|_| "Video sources are unavailable.")?;
        load_or_migrate(&sources_path(app)?)?
    };
    Ok(state.sources.iter().map(|source| (source.name.clone(), source.provider, read_key(&source.id).ok())).collect())
}

#[cfg(windows)]
fn read_key(id: &str) -> Result<String, String> {
    match key_entry(id)?.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Err("This source's API key is missing. Remove the source and add it again.".into()),
        Err(_) => Err("Could not read the key from Windows Credential Manager.".into()),
    }
}

#[cfg(windows)]
fn delete_key(id: &str) -> Result<(), String> {
    match key_entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the key from Windows Credential Manager.".into()),
    }
}

#[cfg(windows)]
fn legacy_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(LEGACY_KLING_SERVICE, LEGACY_KLING_ACCOUNT)
        .map_err(|_| "Windows Credential Manager is unavailable.".into())
}

#[cfg(windows)]
fn take_legacy_kling_key() -> Result<Option<String>, String> {
    match legacy_entry()?.get_password() {
        Ok(key) => Ok(clean_key(&key).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the saved Kling key from Windows Credential Manager.".into()),
    }
}

#[cfg(windows)]
fn delete_legacy_kling_key() {
    if let Ok(entry) = legacy_entry() {
        let _ = entry.delete_credential();
    }
}

#[cfg(not(windows))]
fn store_key(_: &str, _: &str) -> Result<(), String> {
    Err("Video source keys are currently supported on Windows only.".into())
}
#[cfg(not(windows))]
fn read_key(_: &str) -> Result<String, String> {
    Err("Video source keys are currently supported on Windows only.".into())
}
#[cfg(not(windows))]
fn delete_key(_: &str) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
fn take_legacy_kling_key() -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(windows))]
fn delete_legacy_kling_key() {}

/// The source a generation request should use: the one named, or the active one.
pub fn resolve(app: &AppHandle, lock: &SourcesLock, id: Option<&str>) -> Result<VideoSource, String> {
    let _guard = lock.0.lock().map_err(|_| "Video sources are unavailable.")?;
    let state = load_or_migrate(&sources_path(app)?)?;
    let id = id.or(state.active.as_deref()).ok_or("Add a video source under Video sources first.")?;
    let source = state.sources.into_iter().find(|source| source.id == id).ok_or("That video source no longer exists.")?;
    if source.status == SourceStatus::Rejected {
        return Err(format!("{} has a rejected API key. Update it under Video sources.", source.name));
    }
    Ok(source)
}

pub fn read_source_key(id: &str) -> Result<String, String> {
    read_key(id)
}

/// The Grok source whose xAI key the assistant and picture maker share:
/// the active one when it is Grok, else the first verified, else any usable one.
fn pick_grok(state: &SourcesState) -> Option<&VideoSource> {
    let grok = |source: &&VideoSource| source.provider == VideoProvider::Grok && source.status != SourceStatus::Rejected;
    state
        .active
        .as_ref()
        .and_then(|id| state.sources.iter().filter(grok).find(|source| &source.id == id))
        .or_else(|| state.sources.iter().filter(grok).find(|source| source.status == SourceStatus::Verified))
        .or_else(|| state.sources.iter().find(grok))
}

/// The xAI key saved with a Grok video source, so one key covers video, chat and pictures.
pub fn xai_key(app: &AppHandle, lock: &SourcesLock) -> Result<String, String> {
    let id = {
        let _guard = lock.0.lock().map_err(|_| "Video sources are unavailable.")?;
        let state = load_or_migrate(&sources_path(app)?)?;
        pick_grok(&state).map(|source| source.id.clone())
    };
    read_key(&id.ok_or(NO_XAI_KEY)?)
}

/// The installed app's xAI key, for live tests run on Nate's PC.
#[cfg(all(test, windows))]
pub fn installed_app_xai_key() -> Result<String, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA is not set")?;
    let path = Path::new(&appdata).join("com.socialmanager.desktop").join(SOURCES_FILE);
    let state = load_or_migrate(&path)?;
    read_key(&pick_grok(&state).ok_or(NO_XAI_KEY)?.id)
}

pub const NO_XAI_KEY: &str = "Add your xAI key under Settings > Video sources (Grok Imagine). The assistant and picture maker use the same key.";

// ---------- provider checks ----------

#[derive(Deserialize)]
struct KlingEnvelope {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    data: Option<KlingUsage>,
}

#[derive(Deserialize)]
struct KlingUsage {
    #[serde(default)]
    resource_pack_subscribe_infos: Vec<KlingPack>,
}

#[derive(Deserialize)]
struct KlingPack {
    #[serde(default)]
    remaining_quantity: Option<f64>,
    #[serde(default)]
    status: Option<String>,
}

/// Reads Kling's answer to `GET /account/costs`, which is free to call.
fn kling_verdict(status: u16, body: &str) -> Verdict {
    let envelope: Option<KlingEnvelope> = serde_json::from_str(body).ok();
    let code = envelope.as_ref().map_or(0, |value| value.code);
    if status == 401 || (1000..=1004).contains(&code) {
        return Verdict::Rejected("Kling did not accept this API key.".into());
    }
    if status == 403 || code == 1103 {
        return Verdict::Rejected("This Kling key does not have API access.".into());
    }
    // The key authenticated, but the account itself needs attention.
    if matches!(code, 1100..=1102) {
        let detail = match code {
            1101 => "Kling says the account is in arrears.",
            1102 => "No Kling resource packs left. Buy more to generate.",
            _ => "Kling reports a problem with this account.",
        };
        return Verdict::Verified { credits: Some(0.0), detail: Some(detail.into()) };
    }
    if (200..300).contains(&status) && code == 0 {
        let packs = envelope
            .and_then(|value| value.data)
            .map(|data| data.resource_pack_subscribe_infos)
            .unwrap_or_default();
        let credits = packs
            .iter()
            .filter(|pack| pack.status.as_deref() == Some("online"))
            .filter_map(|pack| pack.remaining_quantity)
            .sum::<f64>();
        let detail = packs.is_empty().then(|| "No resource packs on this Kling account yet.".to_string());
        return Verdict::Verified { credits: Some(credits), detail };
    }
    let reason = envelope
        .and_then(|value| value.message)
        .filter(|message| !message.trim().is_empty())
        .map(|message| message.chars().take(160).collect::<String>())
        .unwrap_or_else(|| format!("HTTP {status}"));
    Verdict::Unavailable(format!("Kling could not check the key right now ({reason}). Try again shortly."))
}

#[derive(Deserialize)]
struct GrokModels {
    #[serde(default)]
    models: Vec<serde_json::Value>,
}

/// Reads xAI's answer to `GET /video-generation-models`, which costs nothing.
fn grok_verdict(status: u16, body: &str) -> Verdict {
    match status {
        200..=299 => {
            let count = serde_json::from_str::<GrokModels>(body).map(|value| value.models.len()).unwrap_or(0);
            let detail = (count == 0).then(|| "This key has no Grok video models enabled. Allow them in the xAI console.".to_string());
            Verdict::Verified { credits: None, detail }
        }
        400 | 401 => Verdict::Rejected("xAI did not accept this API key.".into()),
        403 => Verdict::Rejected("This xAI key is not allowed to use video models.".into()),
        _ => Verdict::Unavailable(format!("xAI could not check the key right now (HTTP {status}). Try again shortly.")),
    }
}

async fn check_key(provider: VideoProvider, key: &str) -> Verdict {
    match provider {
        VideoProvider::Grok => {
            let client = match crate::grok::api_client() {
                Ok(client) => client,
                Err(reason) => return Verdict::Unavailable(reason),
            };
            match client.get(format!("{}/video-generation-models", crate::grok::API_BASE)).bearer_auth(key).send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    grok_verdict(status, &body)
                }
                Err(_) => Verdict::Unavailable("Could not reach xAI. Check your connection and try again.".into()),
            }
        }
        VideoProvider::Kling => {
            let client = match reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(REQUEST_TIMEOUT)
                .build()
            {
                Ok(client) => client,
                Err(_) => return Verdict::Unavailable("Could not start a connection to Kling.".into()),
            };
            let end = now_ms();
            let start = end.saturating_sub(USAGE_WINDOW_MS);
            let response = client
                .get(format!("{}/account/costs", crate::kling::API_BASE))
                .bearer_auth(key)
                .query(&[("start_time", start.to_string()), ("end_time", end.to_string())])
                .send()
                .await;
            match response {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    kling_verdict(status, &body)
                }
                Err(_) => Verdict::Unavailable("Could not reach Kling. Check your connection and try again.".into()),
            }
        }
    }
}

fn apply(source: &mut VideoSource, verdict: Verdict) -> Result<(), String> {
    match verdict {
        Verdict::Verified { credits, detail } => {
            source.status = SourceStatus::Verified;
            source.checked_at = Some(now_ms());
            source.credits_remaining = credits;
            source.detail = detail;
            Ok(())
        }
        Verdict::Rejected(reason) => {
            source.status = SourceStatus::Rejected;
            source.checked_at = Some(now_ms());
            source.credits_remaining = None;
            source.detail = Some(reason);
            Ok(())
        }
        Verdict::Unavailable(reason) => Err(reason),
    }
}

// ---------- commands ----------

#[tauri::command]
pub fn list_video_sources(app: AppHandle, lock: State<'_, SourcesLock>) -> Result<SourcesState, String> {
    let _guard = lock.0.lock().map_err(|_| "Video sources are unavailable.")?;
    load_or_migrate(&sources_path(&app)?)
}

/// Chooses the source every video generation uses until it is changed again.
#[tauri::command]
pub fn set_active_video_source(app: AppHandle, lock: State<'_, SourcesLock>, id: String) -> Result<SourcesState, String> {
    with_sources(&app, &lock, |state| {
        let source = state.sources.iter().find(|source| source.id == id).ok_or("Unknown video source.")?;
        if source.status == SourceStatus::Rejected {
            return Err("That source's key was rejected. Check it again or add a new key first.".into());
        }
        state.active = Some(id);
        Ok(())
    })?;
    let _guard = lock.0.lock().map_err(|_| "Video sources are unavailable.")?;
    load_or_migrate(&sources_path(&app)?)
}

/// Checks the key with the provider first; a key the provider rejects is never saved.
#[tauri::command]
pub async fn add_video_source(
    app: AppHandle,
    lock: State<'_, SourcesLock>,
    name: String,
    provider: VideoProvider,
    key: String,
) -> Result<VideoSource, String> {
    let name = clean_name(&name)?;
    let key = clean_key(&key)?;
    let mut source = VideoSource {
        id: new_id()?,
        name,
        provider,
        status: SourceStatus::Unchecked,
        checked_at: None,
        credits_remaining: None,
        detail: None,
    };
    match check_key(provider, &key).await {
        Verdict::Rejected(reason) => return Err(reason),
        verdict => apply(&mut source, verdict)?,
    }
    with_sources(&app, &lock, |state| {
        if state.sources.len() >= MAX_SOURCES {
            return Err(format!("You can add up to {MAX_SOURCES} video sources."));
        }
        ensure_unique_name(&state.sources, &source.name, None)?;
        store_key(&source.id, &key)?;
        state.sources.push(source.clone());
        Ok(source)
    })
}

#[tauri::command]
pub async fn check_video_source(app: AppHandle, lock: State<'_, SourcesLock>, id: String) -> Result<VideoSource, String> {
    let provider = {
        let _guard = lock.0.lock().map_err(|_| "Video sources are unavailable.")?;
        load_or_migrate(&sources_path(&app)?)?
            .sources
            .iter()
            .find(|source| source.id == id)
            .map(|source| source.provider)
            .ok_or("Unknown video source.")?
    };
    let key = read_key(&id)?;
    let verdict = check_key(provider, &key).await;
    with_sources(&app, &lock, |state| {
        let source = state.sources.iter_mut().find(|source| source.id == id).ok_or("Unknown video source.")?;
        apply(source, verdict)?;
        Ok(source.clone())
    })
}

#[tauri::command]
pub fn rename_video_source(app: AppHandle, lock: State<'_, SourcesLock>, id: String, name: String) -> Result<VideoSource, String> {
    let name = clean_name(&name)?;
    with_sources(&app, &lock, |state| {
        ensure_unique_name(&state.sources, &name, Some(&id))?;
        let source = state.sources.iter_mut().find(|source| source.id == id).ok_or("Unknown video source.")?;
        source.name = name;
        Ok(source.clone())
    })
}

#[tauri::command]
pub fn remove_video_source(app: AppHandle, lock: State<'_, SourcesLock>, id: String) -> Result<(), String> {
    with_sources(&app, &lock, |state| {
        let before = state.sources.len();
        state.sources.retain(|source| source.id != id);
        if state.sources.len() == before {
            return Err("Unknown video source.".into());
        }
        delete_key(&id)
    })
}

#[tauri::command]
pub async fn open_video_provider_keys(app: AppHandle, provider: VideoProvider) -> Result<(), String> {
    let url = match provider {
        VideoProvider::Kling => "https://kling.ai/dev/api-key",
        VideoProvider::Grok => "https://console.x.ai/",
    };
    crate::browser::open_remote(&app, url, false)
}

#[tauri::command]
pub async fn open_video_provider_site(app: AppHandle, provider: VideoProvider) -> Result<(), String> {
    let url = match provider {
        VideoProvider::Kling => "https://klingai.com/",
        VideoProvider::Grok => "https://grok.com/imagine",
    };
    crate::browser::open_remote(&app, url, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_keys_are_recognized_from_status_or_code() {
        assert!(matches!(kling_verdict(401, ""), Verdict::Rejected(_)));
        assert!(matches!(kling_verdict(200, r#"{"code":1002,"message":"bad"}"#), Verdict::Rejected(_)));
        assert!(matches!(kling_verdict(403, r#"{"code":1103}"#), Verdict::Rejected(_)));
    }

    #[test]
    fn verified_keys_sum_only_active_packs() {
        let body = r#"{"code":0,"data":{"code":0,"resource_pack_subscribe_infos":[
            {"remaining_quantity":118.0,"status":"online"},
            {"remaining_quantity":40.0,"status":"expired"},
            {"remaining_quantity":2.5,"status":"online"}]}}"#;
        assert_eq!(kling_verdict(200, body), Verdict::Verified { credits: Some(120.5), detail: None });
        let empty = kling_verdict(200, r#"{"code":0,"data":{"resource_pack_subscribe_infos":[]}}"#);
        assert!(matches!(empty, Verdict::Verified { credits: Some(c), detail: Some(_) } if c == 0.0));
    }

    #[test]
    fn account_problems_still_verify_the_key() {
        assert!(matches!(kling_verdict(429, r#"{"code":1102}"#), Verdict::Verified { detail: Some(_), .. }));
    }

    #[test]
    fn outages_do_not_change_a_keys_status() {
        assert!(matches!(kling_verdict(503, r#"{"code":5001,"message":"maintenance"}"#), Verdict::Unavailable(_)));
        assert!(matches!(kling_verdict(500, "not json"), Verdict::Unavailable(_)));
        let mut source = VideoSource {
            id: "ab".into(), name: "Main".into(), provider: VideoProvider::Kling,
            status: SourceStatus::Verified, checked_at: Some(1), credits_remaining: Some(3.0), detail: None,
        };
        assert!(apply(&mut source, Verdict::Unavailable("down".into())).is_err());
        assert_eq!(source.status, SourceStatus::Verified);
    }

    #[test]
    fn names_and_keys_are_validated() {
        assert_eq!(clean_name("  Main  ").unwrap(), "Main");
        assert!(clean_name(" ").is_err());
        assert!(clean_name(&"a".repeat(61)).is_err());
        assert!(clean_key("abc def").is_err());
        assert_eq!(clean_key(" abc ").unwrap(), "abc");
        let existing = vec![VideoSource {
            id: "ab".into(), name: "Main".into(), provider: VideoProvider::Kling,
            status: SourceStatus::Unchecked, checked_at: None, credits_remaining: None, detail: None,
        }];
        assert!(ensure_unique_name(&existing, "main", None).is_err());
        assert!(ensure_unique_name(&existing, "main", Some("ab")).is_ok());
    }

    fn source(id: &str, status: SourceStatus) -> VideoSource {
        VideoSource { id: id.into(), name: id.into(), provider: VideoProvider::Grok, status, checked_at: None, credits_remaining: None, detail: None }
    }

    #[test]
    fn grok_keys_are_checked_by_listing_video_models() {
        assert_eq!(grok_verdict(200, r#"{"models":[{"id":"grok-imagine-video"}]}"#), Verdict::Verified { credits: None, detail: None });
        assert!(matches!(grok_verdict(200, r#"{"models":[]}"#), Verdict::Verified { detail: Some(_), .. }));
        assert!(matches!(grok_verdict(401, ""), Verdict::Rejected(_)));
        assert!(matches!(grok_verdict(400, r#"{"error":"Incorrect API key"}"#), Verdict::Rejected(_)));
        assert!(matches!(grok_verdict(503, ""), Verdict::Unavailable(_)));
    }

    #[test]
    fn the_xai_key_comes_from_a_usable_grok_source() {
        let kling = VideoSource { provider: VideoProvider::Kling, ..source("k", SourceStatus::Verified) };
        let mut state = SourcesState { active: Some("k".into()), sources: vec![kling, source("r", SourceStatus::Rejected), source("u", SourceStatus::Unchecked), source("v", SourceStatus::Verified)] };
        assert_eq!(pick_grok(&state).map(|item| item.id.as_str()), Some("v"), "a verified Grok source wins over a Kling active one");
        state.active = Some("u".into());
        assert_eq!(pick_grok(&state).map(|item| item.id.as_str()), Some("u"), "the active Grok source is used");
        state.sources.retain(|item| item.id != "v" && item.id != "u");
        assert!(pick_grok(&state).is_none(), "rejected keys and Kling keys are never used");
    }

    #[test]
    fn the_active_source_always_points_at_a_usable_source() {
        let mut state = SourcesState { active: None, sources: vec![source("a", SourceStatus::Rejected), source("b", SourceStatus::Unchecked), source("c", SourceStatus::Verified)] };
        state.repair_active();
        assert_eq!(state.active.as_deref(), Some("c"));
        state.active = Some("b".into());
        state.repair_active();
        assert_eq!(state.active.as_deref(), Some("b"), "a chosen unchecked source is kept");
        state.sources.retain(|item| item.id != "b");
        state.repair_active();
        assert_eq!(state.active.as_deref(), Some("c"));
        state.sources = vec![source("a", SourceStatus::Rejected)];
        state.repair_active();
        assert_eq!(state.active, None);
    }

    #[test]
    fn files_from_before_the_active_source_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SOURCES_FILE);
        fs::write(&path, serde_json::to_vec(&vec![source("k1", SourceStatus::Verified)]).unwrap()).unwrap();
        let state = read_sources(&path).unwrap().unwrap();
        assert_eq!(state.active.as_deref(), Some("k1"));
        assert_eq!(state.sources.len(), 1);
    }

    #[test]
    fn sources_round_trip_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SOURCES_FILE);
        assert_eq!(read_sources(&path).unwrap(), None);
        let state = SourcesState { active: Some("0a1b".into()), sources: vec![VideoSource {
            id: "0a1b".into(), name: "Studio".into(), provider: VideoProvider::Kling,
            status: SourceStatus::Verified, checked_at: Some(5), credits_remaining: Some(1.0), detail: None,
        }] };
        write_sources(&path, &state).unwrap();
        assert_eq!(read_sources(&path).unwrap(), Some(state));
    }
}
