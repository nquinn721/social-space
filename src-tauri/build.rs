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
    ];
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}
