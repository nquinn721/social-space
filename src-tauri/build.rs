fn main() {
    let commands = &[
        "load_workspace",
        "save_workspace",
        "open_platform_action",
        "open_kling",
        "open_kling_developer",
        "kling_key_status",
        "save_kling_key",
        "remove_kling_key",
        "generate_kling_video",
        "get_kling_video",
        "open_kling_video",
        "connect_x",
        "x_connection",
        "disconnect_x",
        "post_to_x",
        "connect_instagram",
        "instagram_connection",
        "disconnect_instagram",
        "publish_instagram_reel",
        "list_queue",
        "add_queue_job",
        "complete_queue_job",
        "delete_queue_job",
        "choose_video_file",
        "ollama_models",
        "ollama_chat",
        "email_connection",
        "connect_email",
        "disconnect_email",
        "list_emails",
        "read_email",
        "open_gmail_sign_in",
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
        "check_for_update",
        "install_update",
    ];
    record_build_source();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}

/// Bakes the source commit and folder into the binary so the app can update itself from main.
fn record_build_source() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest_dir.parent().unwrap_or(&manifest_dir).to_path_buf();
    let commit = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|commit| !commit.is_empty())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=SOCIALSPACE_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=SOCIALSPACE_SOURCE_DIR={}", repo.display());
    // Rebuild when the checked-out commit changes, so the recorded commit never goes stale.
    for path in [".git/HEAD", ".git/refs/heads", ".git/packed-refs"] {
        println!("cargo:rerun-if-changed={}", repo.join(path).display());
    }
}
