use std::{collections::{BTreeMap, HashSet}, fs, io::Write, path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
mod account_passwords;
mod backup;
mod brand_images;
mod browser_sessions;
mod gemini_ai;
mod autofill;
mod browser;
mod email;
mod embedded;
mod gmail_session;
mod hub;
mod grok;
mod grok_ai;
mod dev_apps;
mod instagram;
mod instagram_login;
mod social_connect;
mod kling;
mod posting;
mod sign_in_state;
mod queue;
mod review;
mod setup_pages;
mod team_sync;
mod updater;
mod video_files;
mod video_gen;
mod video_sources;
mod x_integration;

const WORKSPACE_FILE: &str = "workspace.json";
const MAX_ACCOUNTS: usize = 200;
const MAX_FIELD_LENGTH: usize = 1_000;
const MAX_VIDEOS: usize = 20_000;
const MAX_CAPTION_LENGTH: usize = 4_000;
const MAX_SETUP_MARKS: usize = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    business_name: String,
    #[serde(default)]
    brands: Vec<Brand>,
    accounts: Vec<Account>,
    #[serde(default)]
    channels: Vec<Channel>,
    #[serde(default)]
    categories: Vec<VideoCategory>,
    #[serde(default)]
    videos: Vec<Video>,
    /// Setup steps the user marked done by hand (developer plans, app reviews, account settings
    /// the app cannot see), keyed by step id, with when they were marked (ms since 1970).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    setup: BTreeMap<String, u64>,
    /// The one developer account per social (TikTok for Developers, Google Cloud, X, Meta), keyed by
    /// provider. Its password is kept with the account passwords under `developer-<provider>`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    developer_logins: BTreeMap<String, DeveloperLogin>,
}

/// A developer-site sign-in tracked by the app: it uses the main email, not a brand's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DeveloperLogin {
    email: String,
}

/// A kind of video inside a brand, e.g. "Rabbit".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VideoCategory {
    id: String,
    brand_id: String,
    name: String,
    /// The description and hashtags new posts of this category start from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    defaults: Option<serde_json::Value>,
}

/// One video of a category, posted to every social of its brand. `posted` lists the socials it is up on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Video {
    id: String,
    brand_id: String,
    category_id: String,
    title: String,
    #[serde(default)]
    media_source: String,
    #[serde(default)]
    caption: String,
    #[serde(default)]
    posted: Vec<Platform>,
    #[serde(default)]
    created_at: u64,
    /// Set while an AI video source is still making this video; cleared once the file is saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation: Option<Generation>,
    /// The post's hashtags, cover and per-social choices, as the interface edits them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
    /// What the video was made from, kept so the assistant can describe it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    /// Link to the live post on each social it was published to by the app.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    links: BTreeMap<String, String>,
    /// Socials it was marked posted on while that social's app still ran in test mode (TikTok
    /// Sandbox, YouTube before the audit), with when (ms). Moved over once the app is approved.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    test_posts: BTreeMap<String, u64>,
}

/// An AI generation in progress for a library video.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Generation {
    source_id: String,
    source_name: String,
    provider: video_sources::VideoProvider,
    task_id: String,
    prompt: String,
    /// "working" or "failed".
    status: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Channel {
    id: String,
    platform: Platform,
    name: String,
    handle: String,
    account_id: Option<String>,
    notes: String,
}

/// A brand or category that owns one profile per social.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Brand {
    id: String,
    name: String,
    #[serde(default)]
    notes: String,
    /// The brand's picture (and YouTube banner) used on every profile; see brand_images.rs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image: Option<BrandImage>,
}

/// Names of pictures in the brand pictures folder (`<sha256>.jpg`), not paths, so they sync.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BrandImage {
    file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    banner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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
    /// This social's own picture instead of the brand's (a brand pictures folder name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_file: Option<String>,
    #[serde(default)]
    birthday: String,
    /// Older workspaces have none; the app assigns one by name when it loads them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    brand_id: Option<String>,
    /// The account's own ID on the social (e.g. the Instagram account ID), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    platform_id: Option<String>,
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
    if workspace.business_name.len() > MAX_FIELD_LENGTH || workspace.accounts.len() > MAX_ACCOUNTS || workspace.channels.len() > MAX_ACCOUNTS || workspace.brands.len() > MAX_ACCOUNTS {
        return Err("The workspace is too large to save.".into());
    }
    if workspace.setup.len() > MAX_SETUP_MARKS || workspace.setup.keys().any(|key| key.trim().is_empty() || key.len() > 200) {
        return Err("The setup checklist is too large to save.".into());
    }
    let mut brand_ids = HashSet::new();
    for brand in &workspace.brands {
        if brand.id.trim().is_empty() || brand.name.trim().is_empty() || !brand_ids.insert(&brand.id)
            || [&brand.id, &brand.name, &brand.notes].iter().any(|field| field.len() > MAX_FIELD_LENGTH) {
            return Err("Each brand needs a unique ID, a name, and fields under 1,000 bytes.".into());
        }
    }
    if workspace.accounts.iter().any(|account| account.brand_id.as_ref().is_some_and(|id| !brand_ids.contains(id))) {
        return Err("An account belongs to a brand that does not exist.".into());
    }
    if workspace.accounts.iter().any(|account| account.platform_id.as_ref().is_some_and(|id| id.len() > MAX_FIELD_LENGTH)) {
        return Err("An account's platform ID is too long to save.".into());
    }
    if workspace.categories.len() > MAX_ACCOUNTS * 10 || workspace.videos.len() > MAX_VIDEOS {
        return Err("The workspace has too many categories or videos to save.".into());
    }
    let mut category_ids = HashSet::new();
    for category in &workspace.categories {
        if category.id.trim().is_empty() || category.name.trim().is_empty() || !category_ids.insert(&category.id)
            || !brand_ids.contains(&category.brand_id)
            || [&category.id, &category.name].iter().any(|field| field.len() > MAX_FIELD_LENGTH) {
            return Err("Each category needs a unique ID, a name, and a brand.".into());
        }
    }
    let mut video_ids = HashSet::new();
    for video in &workspace.videos {
        if video.id.trim().is_empty() || !video_ids.insert(&video.id)
            || !workspace.categories.iter().any(|category| category.id == video.category_id && category.brand_id == video.brand_id)
            || [&video.id, &video.title, &video.media_source].iter().any(|field| field.len() > MAX_FIELD_LENGTH)
            || video.caption.len() > MAX_CAPTION_LENGTH
            || video.generation.as_ref().is_some_and(|g| !matches!(g.status.as_str(), "working" | "failed")
                || [&g.source_id, &g.source_name, &g.task_id, &g.message].iter().any(|field| field.len() > MAX_FIELD_LENGTH)
                || g.prompt.len() > MAX_CAPTION_LENGTH) {
            return Err("Each video needs a unique ID and a category of its brand.".into());
        }
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
const META_DEVELOPERS_HOME: &str = "https://developers.facebook.com/";

fn platform_url(platform: Platform, action: &str) -> Option<&'static str> {
    match (platform, action) {
        (Platform::X, "create") => Some("https://x.com/i/flow/signup"),
        (Platform::X, "manage") => Some("https://x.com/settings/account"),
        (Platform::X, "post") => Some("https://x.com/compose/post"),
        (Platform::X, "developer") => Some("https://developer.x.com/"),
        (Platform::Instagram, "create") => Some("https://www.instagram.com/accounts/emailsignup/"),
        (Platform::Instagram, "manage") => Some("https://www.instagram.com/accounts/edit/"),
        (Platform::Instagram, "post") => Some("https://www.instagram.com/"),
        // Instagram moved name and username editing to Accounts Center.
        (Platform::Instagram, "identity") => Some("https://accountscenter.instagram.com/profiles/"),
        // The app list (/apps/) shows "link broken" until you are signed in, so start at the home page.
        (Platform::Instagram, "developer") => Some(META_DEVELOPERS_HOME),
        // Straight to the email sign-up form, past the "Use phone or email / Facebook / Google" chooser.
        (Platform::Tiktok, "create") => Some("https://www.tiktok.com/signup/phone-or-email/email"),
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
    // `--version --json` and `--update check|apply|rollback --json` are for the Ava hub: answer on
    // stdout and exit, no window. `--hub` alone is a normal launch in managed mode (see hub.rs).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(exe) = std::env::current_exe() {
        hub::remove_aside(&exe);
    }
    if let Some(request) = updater::parse_cli(&args) {
        std::process::exit(updater::run_cli(request));
    }
    tauri::Builder::default()
        .manage(StorageLock::default())
        .manage(video_gen::GenerateLock::default())
        .manage(video_sources::SourcesLock::default())
        .setup(|app| { queue::start_scheduler(app.handle().clone()); Ok(()) })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            team_sync::team_sync_status,
            backup::export_accounts_json,
            team_sync::team_sync_enable,
            team_sync::team_sync_disable,
            team_sync::team_sync_fetch,
            team_sync::team_sync_push,
            review::claim_review_post,
            review::export_review_key,
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
            video_gen::save_generated_video,
            video_files::preview_video_file,
            video_files::open_video_file,
            x_integration::connect_x,
            x_integration::x_connection,
            x_integration::disconnect_x,
            x_integration::claim_x_connection,
            instagram::claim_instagram_connection,
            dev_apps::developer_apps,
            social_connect::connect_youtube,
            social_connect::youtube_connection,
            social_connect::disconnect_youtube,
            social_connect::connect_tiktok,
            social_connect::tiktok_connection,
            social_connect::disconnect_tiktok,
            social_connect::check_youtube_connection,
            social_connect::check_tiktok_connection,
            x_integration::check_x_connection,
            setup_pages::open_setup_page,
            dev_apps::save_developer_app,
            dev_apps::remove_developer_app,
            dev_apps::save_production_app,
            dev_apps::use_production_app,
            x_integration::post_to_x,
            instagram::connect_instagram,
            instagram_login::instagram_app_ready,
            instagram_login::save_instagram_app,
            instagram_login::connect_instagram_app,
            instagram_login::finish_instagram_connection,
            instagram::instagram_connection,
            instagram::disconnect_instagram,
            instagram::publish_instagram_reel,
            instagram::publish_instagram_photo,
            instagram::publish_instagram_reel_file,
            instagram::open_instagram_post,
            instagram::choose_instagram_video,
            queue::list_queue,
            queue::add_queue_job,
            queue::complete_queue_job,
            queue::delete_queue_job,
            queue::choose_video_file,
            grok_ai::grok_models,
            grok_ai::grok_chat,
            grok_ai::generate_profile_image,
            gemini_ai::gemini_key_status,
            gemini_ai::save_gemini_key,
            gemini_ai::remove_gemini_key,
            gemini_ai::generate_gemini_images,
            brand_images::save_brand_image,
            brand_images::brand_image_path,
            brand_images::reveal_brand_image,
            email::email_connection,
            email::connect_email,
            email::disconnect_email,
            email::list_emails,
            email::read_email,
            gmail_session::open_gmail_sign_in,
            gmail_session::open_gmail_signup,
            gmail_session::connect_gmail_session,
            gmail_session::open_gmail_message,
            embedded::embed_platform_page,
            embedded::embed_setup_page,
            embedded::set_embedded_bounds,
            embedded::close_embedded_page,
            autofill::fill_site_form,
            posting::open_posting_window,
            posting::open_profile_page,
            sign_in_state::posting_sign_ins,
            autofill::choose_image_file,
            autofill::load_image_preview,
            account_passwords::ensure_account_password,
            account_passwords::has_account_password,
            account_passwords::set_account_password,
            account_passwords::ensure_shared_password,
            account_passwords::reveal_account_password,
            account_passwords::delete_account_password,
            backup::export_sign_ins,
            backup::import_sign_ins,
            updater::check_for_update,
            updater::prepare_update,
            updater::install_prepared_update,
            updater::restart_app,
            updater::update_progress,
            updater::take_update_result,
            hub::update_management,
            hub::request_hub_update,
            review::review_connection,
            review::connect_review,
            review::disconnect_review,
            review::list_reviewers,
            review::add_reviewer,
            review::remove_reviewer,
            review::list_review_posts,
            review::submit_for_review,
            review::record_review_result,
            review::open_review_site,
            review::publish_review_catalog,
            review::import_review_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running Social Space");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_details_prompt_links_and_category_defaults_survive_saving() {
        let json = serde_json::json!({"businessName": "", "accounts": [], "categories": [{"id": "c", "brandId": "b", "name": "Rabbit", "defaults": {"caption": "Hi", "hashtags": ["#bunny"]}}],
            "videos": [{"id": "v", "brandId": "b", "categoryId": "c", "title": "Bunny", "details": {"hashtags": ["#bunny"], "shareToFeed": true, "coverMs": 1500}, "prompt": "a rabbit",
            "links": {"instagram": "https://www.instagram.com/reel/x/"}, "testPosts": {"tiktok": 1700000000000u64}}]});
        let workspace: Workspace = serde_json::from_value(json).unwrap();
        let saved = serde_json::to_value(&workspace).unwrap();
        assert_eq!(saved["videos"][0]["details"]["coverMs"], 1500);
        assert_eq!(saved["videos"][0]["prompt"], "a rabbit");
        assert_eq!(saved["videos"][0]["links"]["instagram"], "https://www.instagram.com/reel/x/");
        assert_eq!(saved["videos"][0]["testPosts"]["tiktok"], 1700000000000u64);
        assert_eq!(saved["categories"][0]["defaults"]["hashtags"][0], "#bunny");
    }

    #[test]
    fn meta_developer_link_opens_a_page_that_works_signed_out() {
        // /apps/ answers "link may be broken" until you sign in, so the button must open the home page.
        let url = platform_url(Platform::Instagram, "developer").unwrap();
        assert_eq!(url, "https://developers.facebook.com/");
        assert_eq!(platform_url(Platform::Instagram, "identity"), Some("https://accountscenter.instagram.com/profiles/"));
    }

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
            image_file: None,
            birthday: String::new(),
            brand_id: None,
            platform_id: None,
        }
    }

    #[test]
    fn workspace_round_trips_and_rejects_duplicate_ids() {
        let mut workspace = Workspace {
            business_name: "Example LLC".into(),
            brands: vec![],
            accounts: vec![account("one")],
            channels: vec![],
            categories: vec![],
            videos: vec![],
            setup: Default::default(),
            developer_logins: Default::default(),
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
    fn brand_pictures_and_per_social_overrides_survive_a_save() {
        let source = r#"{"businessName":"","brands":[{"id":"b","name":"Mia","notes":"","image":{"file":"a.jpg","banner":"b.jpg","prompt":"a fox"}},{"id":"c","name":"Old","notes":""}],"accounts":[{"id":"x","platform":"x","label":"Mia","handle":"mia","status":"planned","notes":"","imageFile":"c.jpg"}]}"#;
        let workspace: Workspace = serde_json::from_str(source).unwrap();
        let saved = serde_json::to_value(&workspace).unwrap();
        assert_eq!(saved["brands"][0]["image"]["banner"], "b.jpg");
        assert_eq!(saved["brands"][0]["image"]["prompt"], "a fox");
        assert!(saved["brands"][1].get("image").is_none());
        assert_eq!(saved["accounts"][0]["imageFile"], "c.jpg");
    }

    #[test]
    fn old_workspaces_load_and_channels_require_a_matching_account() {
        let mut workspace: Workspace = serde_json::from_str(r#"{"businessName":"Old LLC","accounts":[]}"#).unwrap();
        assert!(workspace.channels.is_empty());
        assert!(workspace.developer_logins.is_empty());
        let tracked: Workspace = serde_json::from_str(r#"{"businessName":"","accounts":[],"developerLogins":{"tiktok":{"email":"main@example.com"}}}"#).unwrap();
        assert_eq!(tracked.developer_logins["tiktok"].email, "main@example.com");
        workspace.accounts.push(account("account-1"));
        workspace.channels.push(Channel { id: "channel-1".into(), platform: Platform::Instagram, name: "Main".into(), handle: "main".into(), account_id: Some("account-1".into()), notes: String::new() });
        assert!(validate_workspace(&workspace).is_ok());
        workspace.channels[0].platform = Platform::Youtube;
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn accounts_must_belong_to_a_saved_brand() {
        let mut workspace = Workspace { business_name: String::new(), brands: vec![Brand { id: "b".into(), name: "Massage With Mia".into(), notes: String::new(), image: None }], accounts: vec![account("one")], channels: vec![], categories: vec![], videos: vec![], setup: Default::default(), developer_logins: Default::default() };
        workspace.accounts[0].brand_id = Some("b".into());
        let json = serde_json::to_string(&workspace).unwrap();
        assert!(json.contains(r#""brandId":"b""#));
        assert_eq!(serde_json::from_str::<Workspace>(&json).unwrap(), workspace);
        assert!(validate_workspace(&workspace).is_ok());
        workspace.accounts[0].brand_id = Some("missing".into());
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn videos_must_be_in_a_category_of_their_brand() {
        let mut workspace = Workspace { business_name: String::new(), brands: vec![Brand { id: "b".into(), name: "Mia".into(), notes: String::new(), image: None }], accounts: vec![], channels: vec![], categories: vec![VideoCategory { id: "c".into(), brand_id: "b".into(), name: "Rabbit".into(), defaults: None }], videos: vec![], setup: Default::default(), developer_logins: Default::default() };
        workspace.videos.push(Video { id: "v".into(), brand_id: "b".into(), category_id: "c".into(), title: "Bunny".into(), media_source: String::new(), caption: String::new(), posted: vec![Platform::Tiktok], created_at: 1, generation: None, details: None, prompt: None, links: Default::default(), test_posts: Default::default() });
        let json = serde_json::to_string(&workspace).unwrap();
        assert_eq!(serde_json::from_str::<Workspace>(&json).unwrap(), workspace);
        assert!(validate_workspace(&workspace).is_ok());
        workspace.videos[0].brand_id = "other".into();
        assert!(validate_workspace(&workspace).is_err());
        workspace.videos[0].brand_id = "b".into();
        workspace.categories[0].brand_id = "missing".into();
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn videos_can_carry_an_ai_generation_in_progress() {
        let mut workspace = Workspace { business_name: String::new(), brands: vec![Brand { id: "b".into(), name: "Mia".into(), notes: String::new(), image: None }], accounts: vec![], channels: vec![], categories: vec![VideoCategory { id: "c".into(), brand_id: "b".into(), name: "Rabbit".into(), defaults: None }], videos: vec![], setup: Default::default(), developer_logins: Default::default() };
        let json = serde_json::json!({"id": "v", "brandId": "b", "categoryId": "c", "title": "Bunny", "generation": {"sourceId": "s", "sourceName": "Main", "provider": "kling", "taskId": "t1", "prompt": "a rabbit", "status": "working"}});
        workspace.videos.push(serde_json::from_value(json).unwrap());
        assert!(validate_workspace(&workspace).is_ok());
        let saved = serde_json::to_value(&workspace.videos[0]).unwrap();
        assert_eq!(saved["generation"]["taskId"], "t1");
        workspace.videos[0].generation.as_mut().unwrap().status = "done".into();
        assert!(validate_workspace(&workspace).is_err());
        workspace.videos[0].generation = None;
        assert!(serde_json::to_value(&workspace.videos[0]).unwrap().get("generation").is_none());
    }

    #[test]
    fn platform_actions_never_accept_an_arbitrary_url() {
        assert_eq!(
            platform_url(Platform::Tiktok, "post"),
            Some("https://www.tiktok.com/upload")
        );
        assert_eq!(
            platform_url(Platform::Tiktok, "create"),
            Some("https://www.tiktok.com/signup/phone-or-email/email")
        );
        assert_eq!(platform_url(Platform::X, "https://example.com"), None);
        assert_eq!(platform_url(Platform::Youtube, "unknown"), None);
    }

    #[test]
    fn workspaces_with_fields_this_version_does_not_know_still_load() {
        // A newer build (or a rolled-back one reading newer data) must never lock the user out of
        // their workspace: unknown fields are ignored, and the account's platform ID is kept.
        let json = br#"{"businessName":"Example LLC","brands":[{"id":"b1","name":"Brand","notes":"","colour":"red"}],
            "accounts":[{"id":"a1","platform":"instagram","label":"Main","handle":"example","status":"active","notes":"",
            "brandId":"b1","platformId":"17841400000000000","somethingNew":true}],"futureSection":[1,2]}"#;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        fs::write(&path, json).unwrap();
        let workspace = read_workspace(&path).unwrap();
        assert_eq!(workspace.accounts[0].platform_id.as_deref(), Some("17841400000000000"));
        assert_eq!(workspace.brands[0].name, "Brand");
        write_workspace(&path, &workspace).unwrap();
        assert_eq!(read_workspace(&path).unwrap(), workspace);
        assert!(fs::read_to_string(&path).unwrap().contains("\"platformId\": \"17841400000000000\""));
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
            brands: vec![],
            accounts: vec![account("one")],
            channels: vec![],
            categories: vec![],
            videos: vec![],
            setup: Default::default(),
            developer_logins: Default::default(),
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
