fn main() {
    let commands = &[
        "load_workspace",
        "save_workspace",
        "team_sync_status",
        "team_sync_enable",
        "team_sync_disable",
        "team_sync_fetch",
        "team_sync_push",
        "claim_review_post",
        "export_review_key",
        "open_platform_action",
        "open_kling",
        "list_video_sources",
        "set_active_video_source",
        "open_video_provider_site",
        "add_video_source",
        "check_video_source",
        "rename_video_source",
        "remove_video_source",
        "open_video_provider_keys",
        "generate_video",
        "get_video",
        "open_video",
        "save_generated_video",
        "preview_video_file",
        "open_video_file",
        "connect_x",
        "x_connection",
        "disconnect_x",
        "claim_x_connection",
        "claim_instagram_connection",
        "developer_apps",
        "connect_youtube",
        "youtube_connection",
        "disconnect_youtube",
        "connect_tiktok",
        "tiktok_connection",
        "disconnect_tiktok",
        "check_youtube_connection",
        "check_tiktok_connection",
        "check_x_connection",
        "open_setup_page",
        "embed_setup_page",
        "save_developer_app",
        "remove_developer_app",
        "save_production_app",
        "use_production_app",
        "post_to_x",
        "connect_instagram",
        "instagram_app_ready",
        "save_instagram_app",
        "connect_instagram_app",
        "finish_instagram_connection",
        "instagram_connection",
        "disconnect_instagram",
        "publish_instagram_reel",
        "publish_instagram_photo",
        "publish_instagram_reel_file",
        "open_instagram_post",
        "choose_instagram_video",
        "list_queue",
        "add_queue_job",
        "complete_queue_job",
        "delete_queue_job",
        "choose_video_file",
        "grok_models",
        "grok_chat",
        "generate_profile_image",
        "email_connection",
        "connect_email",
        "disconnect_email",
        "list_emails",
        "read_email",
        "open_gmail_sign_in",
        "open_gmail_signup",
        "connect_gmail_session",
        "open_gmail_message",
        "embed_platform_page",
        "set_embedded_bounds",
        "close_embedded_page",
        "fill_site_form",
        "choose_image_file",
        "load_image_preview",
        "ensure_account_password",
        "has_account_password",
        "set_account_password",
        "ensure_shared_password",
        "reveal_account_password",
        "delete_account_password",
        "export_sign_ins",
        "import_sign_ins",
        "check_for_update",
        "update_management",
        "request_hub_update",
        "prepare_update",
        "install_prepared_update",
        "restart_app",
        "update_progress",
        "take_update_result",
        "review_connection",
        "connect_review",
        "disconnect_review",
        "list_reviewers",
        "add_reviewer",
        "remove_reviewer",
        "list_review_posts",
        "submit_for_review",
        "record_review_result",
        "open_review_site",
        "publish_review_catalog",
        "import_review_video",
    ];
    require_stamping_script();
    record_build_source();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}

/// A release is built only by `npm run tauri:build` (scripts/tauri-build.mjs), which checks the tree
/// is a clean main and stamps its commit. `cargo test` and `tauri dev` build the debug profile.
///
/// Installs from before that script existed update themselves with a plain `npm run tauri build`.
/// Refusing those would strand them on an old version forever, so an unstamped release is still
/// allowed when it passes the same check the script makes: a clean tree at the tip of main. Its
/// commit is then recorded from git by `record_build_source`.
fn require_stamping_script() {
    const STAMP_ENV: &str = "SOCIALSPACE_BUILD_STAMPED";
    println!("cargo:rerun-if-env-changed={STAMP_ENV}");
    let release = std::env::var("PROFILE").is_ok_and(|profile| profile == "release");
    if !release || std::env::var(STAMP_ENV).is_ok() {
        return;
    }
    match unstamped_release_problem() {
        None => println!("cargo:warning=Building a clean main without `npm run tauri:build` (an older updater); the commit is read from git."),
        Some(problem) => panic!("Build releases with `npm run tauri:build`: it checks the tree is a clean main and stamps its commit. ({problem})"),
    }
}

/// Why an unstamped release must not be built, or None when the tree is a clean tip of main.
fn unstamped_release_problem() -> Option<String> {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").ok()?);
    let tree = manifest_dir.parent().unwrap_or(&manifest_dir).to_path_buf();
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&tree)
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let Some(head) = git(&["rev-parse", "HEAD"]).filter(|head| !head.is_empty()) else {
        return Some("the tree is not a git checkout".into());
    };
    match git(&["status", "--porcelain", "--untracked-files=no"]) {
        Some(changed) if changed.is_empty() => {}
        _ => return Some("the tree has uncommitted changes".into()),
    }
    let on_main = ["refs/remotes/origin/main^{commit}", "refs/heads/main^{commit}"]
        .iter()
        .filter_map(|reference| git(&["rev-parse", "--verify", "--quiet", reference]))
        .any(|main| main == head);
    if on_main {
        None
    } else {
        Some(format!("HEAD {} is not the tip of main or origin/main", head.get(..7).unwrap_or(&head)))
    }
}

/// Bakes the source commit and repository into the binary so the app can update itself from main.
///
/// The commit is the one of the tree actually being compiled (a worktree has its own HEAD), and
/// the source folder is the repository that owns the git objects: for a worktree that is the main
/// checkout, so an update build made in the updater's own worktree still points back at the repo.
/// `scripts/tauri-build.mjs` and the updater set both explicitly; these are the fallbacks.
fn record_build_source() {
    const COMMIT_ENV: &str = "SOCIALSPACE_BUILD_COMMIT";
    const SOURCE_ENV: &str = "SOCIALSPACE_SOURCE_DIR";
    println!("cargo:rerun-if-env-changed={COMMIT_ENV}");
    println!("cargo:rerun-if-env-changed=SOCIALSPACE_RELEASE_CHANNEL");
    println!("cargo:rerun-if-env-changed={SOURCE_ENV}");
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let tree = manifest_dir.parent().unwrap_or(&manifest_dir).to_path_buf();
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&tree)
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let from_env = |name: &str| std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    let commit = from_env(COMMIT_ENV).or_else(|| git(&["rev-parse", "HEAD"])).unwrap_or_else(|| "unknown".into());
    let git_dir = git(&["rev-parse", "--path-format=absolute", "--git-dir"]).map(std::path::PathBuf::from);
    let common_dir = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]).map(std::path::PathBuf::from);
    let source = from_env(SOURCE_ENV)
        .map(std::path::PathBuf::from)
        .or_else(|| common_dir.as_ref().and_then(|dir| dir.parent()).map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| tree.clone());
    println!("cargo:rustc-env={COMMIT_ENV}={commit}");
    println!("cargo:rustc-env={SOURCE_ENV}={}", source.display());
    // Rebuild when the checked-out commit changes, so the recorded commit never goes stale.
    if let Some(dir) = git_dir {
        // logs/HEAD is appended on every commit, checkout and reset, even when HEAD names a branch.
        for path in ["HEAD", "logs/HEAD"] {
            println!("cargo:rerun-if-changed={}", dir.join(path).display());
        }
    }
    if let Some(dir) = common_dir {
        for path in ["refs/heads", "packed-refs"] {
            println!("cargo:rerun-if-changed={}", dir.join(path).display());
        }
    }
}
