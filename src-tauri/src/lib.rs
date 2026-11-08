use std::{collections::HashSet, fs, io::Write, path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
mod account_passwords;
mod autofill;
mod browser;
mod email;
mod embedded;
mod gmail_session;
mod grok;
mod instagram;
mod kling;
mod ollama;
mod queue;
mod updater;
mod video_gen;
mod video_sources;
mod x_integration;

const WORKSPACE_FILE: &str = "workspace.json";
const MAX_ACCOUNTS: usize = 200;
const MAX_FIELD_LENGTH: usize = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Workspace {
    business_name: String,
    accounts: Vec<Account>,
    #[serde(default)]
    channels: Vec<Channel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Channel {
    id: String,
    platform: Platform,
    name: String,
    handle: String,
    account_id: Option<String>,
    notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Account {
    id: String,
    platform: Platform,
    label: String,
    handle: String,
    status: AccountStatus,
    notes: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    bio: String,
    #[serde(default)]
    website: String,
    #[serde(default)]
    signup_email: String,
    #[serde(default)]
    image_path: String,
    #[serde(default)]
    birthday: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Platform {
    X,
    Instagram,
    Tiktok,
    Youtube,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AccountStatus {
    Planned,
    Active,
}

#[derive(Default)]
struct StorageLock(Mutex<()>);

fn validate_workspace(workspace: &Workspace) -> Result<(), String> {
    if workspace.business_name.len() > MAX_FIELD_LENGTH || workspace.accounts.len() > MAX_ACCOUNTS || workspace.channels.len() > MAX_ACCOUNTS {
        return Err("The workspace is too large to save.".into());
    }
    let mut ids = HashSet::new();
    for account in &workspace.accounts {
        if account.id.trim().is_empty()
            || !ids.insert(&account.id)
            || [&account.id, &account.label, &account.handle, &account.notes, &account.display_name, &account.bio, &account.website, &account.signup_email, &account.image_path, &account.birthday]
                .iter()
                .any(|field| field.len() > MAX_FIELD_LENGTH)
        {
            return Err("Each account needs a unique ID and fields under 1,000 bytes.".into());
        }
    }
    let mut channel_ids = HashSet::new();
    for channel in &workspace.channels {
        if channel.id.trim().is_empty() || channel.name.trim().is_empty()
            || !channel_ids.insert(&channel.id)
            || [&channel.id, &channel.name, &channel.handle, &channel.notes].iter().any(|field| field.len() > MAX_FIELD_LENGTH)
            || channel.account_id.as_ref().is_some_and(|id| !workspace.accounts.iter().any(|account| &account.id == id && account.platform == channel.platform)) {
            return Err("Each channel needs a unique ID, a name, and a matching account if linked.".into());
        }
    }
    Ok(())
}

fn read_workspace(path: &Path) -> Result<Workspace, String> {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map_err(|error| format!("Could not read workspace data: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Workspace::default()),
        Err(error) => Err(format!("Could not open workspace data: {error}")),
    }
}

fn write_workspace(path: &Path, workspace: &Workspace) -> Result<(), String> {
    validate_workspace(workspace)?;
    let parent = path.parent().ok_or("Invalid workspace path.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create workspace folder: {error}"))?;
    let contents = serde_json::to_vec_pretty(workspace)
        .map_err(|error| format!("Could not encode workspace data: {error}"))?;
    // Replace the old file only after the complete new version is on disk.
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Could not prepare workspace data: {error}"))?;
    temporary
        .write_all(&contents)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Could not write workspace data: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Could not save workspace data: {}", error.error))?;
    Ok(())
}

fn workspace_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(WORKSPACE_FILE))
        .map_err(|error| format!("Could not locate workspace folder: {error}"))
}

#[tauri::command]
fn load_workspace(
    app: tauri::AppHandle,
    lock: State<'_, StorageLock>,
) -> Result<Workspace, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Workspace storage is unavailable.")?;
    read_workspace(&workspace_path(&app)?)
}

#[tauri::command]
fn save_workspace(
    app: tauri::AppHandle,
    lock: State<'_, StorageLock>,
    workspace: Workspace,
) -> Result<Workspace, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Workspace storage is unavailable.")?;
    write_workspace(&workspace_path(&app)?, &workspace)?;
    Ok(workspace)
}

// URLs are selected entirely in Rust, so the webview cannot open arbitrary destinations.
fn platform_url(platform: Platform, action: &str) -> Option<&'static str> {
    match (platform, action) {
        (Platform::X, "create") => Some("https://x.com/i/flow/signup"),
        (Platform::X, "manage") => Some("https://x.com/settings/account"),
        (Platform::X, "post") => Some("https://x.com/compose/post"),
        (Platform::X, "developer") => Some("https://developer.x.com/"),
        (Platform::Instagram, "create") => Some("https://www.instagram.com/accounts/emailsignup/"),
        (Platform::Instagram, "manage") => Some("https://www.instagram.com/accounts/edit/"),
        (Platform::Instagram, "post") => Some("https://www.instagram.com/"),
        (Platform::Instagram, "developer") => {
            Some("https://developers.facebook.com/products/instagram/")
        }
        (Platform::Tiktok, "create") => Some("https://www.tiktok.com/signup"),
        (Platform::Tiktok, "manage") => Some("https://www.tiktok.com/setting"),
        (Platform::Tiktok, "post") => Some("https://www.tiktok.com/upload"),
        (Platform::Tiktok, "developer") => Some("https://developers.tiktok.com/"),
        (Platform::Youtube, "create") => Some("https://www.youtube.com/create_channel"),
        (Platform::Youtube, "manage") => Some("https://studio.youtube.com/"),
        (Platform::Youtube, "post") => Some("https://www.youtube.com/upload"),
        (Platform::Youtube, "developer") => Some("https://developers.google.com/youtube/v3"),
        _ => None,
    }
}

#[tauri::command]
async fn open_platform_action(
    app: tauri::AppHandle,
    platform: Platform,
    action: String,
) -> Result<String, String> {
    let url = platform_url(platform, &action).ok_or("Unknown platform action.")?;
    browser::open_remote_window(&app, url, false)
}

#[tauri::command]
async fn open_kling(app: tauri::AppHandle) -> Result<(), String> {
    browser::open_remote(&app, "https://klingai.com/", false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(StorageLock::default())
        .manage(video_gen::GenerateLock::default())
        .manage(video_sources::SourcesLock::default())
        .setup(|app| { queue::start_scheduler(app.handle().clone()); Ok(()) })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            open_platform_action,
            open_kling,
            video_sources::list_video_sources,
            video_sources::set_active_video_source,
            video_sources::open_video_provider_site,
            video_sources::add_video_source,
            video_sources::check_video_source,
            video_sources::rename_video_source,
            video_sources::remove_video_source,
            video_sources::open_video_provider_keys,
            video_gen::generate_video,
            video_gen::get_video,
            video_gen::open_video,
            x_integration::connect_x,
            x_integration::x_connection,
            x_integration::disconnect_x,
            x_integration::post_to_x,
            instagram::connect_instagram,
            instagram::instagram_connection,
            instagram::disconnect_instagram,
            instagram::publish_instagram_reel,
            queue::list_queue,
            queue::add_queue_job,
            queue::complete_queue_job,
            queue::delete_queue_job,
            queue::choose_video_file,
            ollama::ollama_models,
            ollama::ollama_chat,
            email::email_connection,
            email::connect_email,
            email::disconnect_email,
            email::list_emails,
            email::read_email,
            gmail_session::open_gmail_sign_in,
            gmail_session::connect_gmail_session,
            gmail_session::open_gmail_message,
            embedded::embed_platform_page,
            embedded::set_embedded_bounds,
            embedded::close_embedded_page,
            autofill::fill_site_form,
            autofill::choose_image_file,
            autofill::load_image_preview,
            account_passwords::ensure_account_password,
            account_passwords::has_account_password,
            account_passwords::set_account_password,
            account_passwords::ensure_shared_password,
            account_passwords::reveal_account_password,
            account_passwords::delete_account_password,
            updater::check_for_update,
            updater::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Social Manager");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> Account {
        Account {
            id: id.into(),
            platform: Platform::Instagram,
            label: "Main account".into(),
            handle: "example".into(),
            status: AccountStatus::Planned,
            notes: String::new(),
            display_name: String::new(),
            bio: String::new(),
            website: String::new(),
            signup_email: String::new(),
            image_path: String::new(),
            birthday: String::new(),
        }
    }

    #[test]
    fn workspace_round_trips_and_rejects_duplicate_ids() {
        let mut workspace = Workspace {
            business_name: "Example LLC".into(),
            accounts: vec![account("one")],
            channels: vec![],
        };
        let json = serde_json::to_string(&workspace).unwrap();
        assert_eq!(serde_json::from_str::<Workspace>(&json).unwrap(), workspace);
        assert!(validate_workspace(&workspace).is_ok());
        workspace.accounts.push(account("one"));
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn accounts_saved_before_profiles_existed_still_load() {
        let workspace: Workspace = serde_json::from_str(r#"{"businessName":"","accounts":[{"id":"a","platform":"x","label":"Main","handle":"m","status":"active","notes":""}]}"#).unwrap();
        assert_eq!(workspace.accounts[0].bio, "");
        assert!(validate_workspace(&workspace).is_ok());
    }

    #[test]
    fn old_workspaces_load_and_channels_require_a_matching_account() {
        let mut workspace: Workspace = serde_json::from_str(r#"{"businessName":"Old LLC","accounts":[]}"#).unwrap();
        assert!(workspace.channels.is_empty());
        workspace.accounts.push(account("account-1"));
        workspace.channels.push(Channel { id: "channel-1".into(), platform: Platform::Instagram, name: "Main".into(), handle: "main".into(), account_id: Some("account-1".into()), notes: String::new() });
        assert!(validate_workspace(&workspace).is_ok());
        workspace.channels[0].platform = Platform::Youtube;
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn platform_actions_never_accept_an_arbitrary_url() {
        assert_eq!(
            platform_url(Platform::Tiktok, "post"),
            Some("https://www.tiktok.com/upload")
        );
        assert_eq!(platform_url(Platform::X, "https://example.com"), None);
        assert_eq!(platform_url(Platform::Youtube, "unknown"), None);
    }

    #[test]
    fn missing_file_returns_an_empty_workspace_and_corruption_is_reported() {
        let directory =
            std::env::temp_dir().join(format!("social-manager-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("missing-workspace.json");
        let _ = fs::remove_file(&path);
        assert_eq!(read_workspace(&path).unwrap(), Workspace::default());
        fs::write(&path, b"not json").unwrap();
        assert!(read_workspace(&path).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn saving_round_trips_and_does_not_overwrite_on_validation_failure() {
        let directory =
            std::env::temp_dir().join(format!("social-manager-save-test-{}", std::process::id()));
        let path = directory.join("workspace.json");
        let workspace = Workspace {
            business_name: "Example LLC".into(),
            accounts: vec![account("one")],
            channels: vec![],
        };
        write_workspace(&path, &workspace).unwrap();
        assert_eq!(read_workspace(&path).unwrap(), workspace);
        let mut updated = workspace.clone();
        updated.business_name = "Updated LLC".into();
        write_workspace(&path, &updated).unwrap();
        assert_eq!(read_workspace(&path).unwrap(), updated);
        let mut invalid = workspace.clone();
        invalid.accounts.push(account("one"));
        assert!(write_workspace(&path, &invalid).is_err());
        assert_eq!(read_workspace(&path).unwrap(), updated);
        fs::remove_dir_all(directory).unwrap();
    }

    /// On Windows a window built inside a sync command deadlocks WebView2 and
    /// shows a blank white window, so every command that opens one is async.
    #[test]
    fn window_opening_commands_are_async() {
        let sources = [
            include_str!("lib.rs"),
            include_str!("gmail_session.rs"),
            include_str!("embedded.rs"),
            include_str!("autofill.rs"),
        ];
        let opens = ["open_remote", "make_window", "WebviewWindowBuilder"];
        for source in sources {
            for (index, _) in source.match_indices(concat!("#[tauri::", "command]")) {
                let rest = &source[index..];
                let signature = &rest[..rest.find('{').unwrap()];
                let body_end = rest.find("\n}").unwrap_or(rest.len());
                let body = &rest[..body_end];
                if opens.iter().any(|open| body.contains(open)) {
                    assert!(signature.contains("async fn"), "a command that opens a window must be async: {signature}");
                }
            }
        }
    }

    /// A command registered in the handler but missing from build.rs or the
    /// capability is rejected at runtime in the installed app.
    #[test]
    fn every_registered_command_is_allowed() {
        let source = include_str!("lib.rs");
        let start = source.find(concat!("generate_handler", "![")).unwrap();
        let handler = &source[start..];
        let handler = &handler[handler.find('[').unwrap() + 1..handler.find(']').unwrap()];
        let build = include_str!("../build.rs");
        let capability = include_str!("../capabilities/default.json");
        for command in handler.split(',').map(|item| item.trim()).filter(|item| !item.is_empty()) {
            let name = command.rsplit("::").next().unwrap();
            assert!(build.contains(&format!("\"{name}\"")), "{name} is missing from build.rs");
            let permission = format!("\"allow-{}\"", name.replace('_', "-"));
            assert!(capability.contains(&permission), "{name} is missing from capabilities/default.json");
        }
    }
}
