//! Self-update from the `main` branch of the local source checkout.
//!
//! The app is built and installed from a git clone on this machine, so the build
//! records which commit it came from and which folder it was built in. Checking
//! for an update fetches `origin/main` in that folder; installing hands off to a
//! PowerShell script that pulls, rebuilds, closes the app, runs the new installer
//! silently and starts the app again.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use serde::Serialize;

/// Commit the running build was compiled from ("unknown" if git was unavailable).
pub const BUILD_COMMIT: &str = env!("SOCIALSPACE_BUILD_COMMIT");
/// Repository root the running build was compiled in.
pub const SOURCE_DIR: &str = env!("SOCIALSPACE_SOURCE_DIR");
const BRANCH: &str = "main";
const MAX_LISTED_COMMITS: &str = "20";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    installed_commit: String,
    latest_commit: Option<String>,
    update_available: bool,
    /// Short hash and subject of each commit on main that this build does not have.
    new_commits: Vec<String>,
    /// Why an update cannot be installed right now, if it cannot.
    blocked_reason: Option<String>,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git {} failed: {}", args.join(" "), stderr.trim()))
    }
}

fn source_dir() -> Result<PathBuf, String> {
    let dir = PathBuf::from(SOURCE_DIR);
    if dir.join(".git").exists() {
        Ok(dir)
    } else {
        Err(format!("The source folder {SOURCE_DIR} is not a git checkout any more."))
    }
}

/// True when `latest` (origin/main) has commits the installed build lacks.
/// A build made from a branch that already contains main is not out of date.
fn needs_update(installed: &str, latest: &str, main_is_in_build: bool) -> bool {
    installed != latest && !main_is_in_build
}

/// Tracked files with local edits would make `git pull` unsafe, so they block an install.
fn local_changes_reason(porcelain: &str) -> Option<String> {
    let changed: Vec<&str> = porcelain
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.get(3..).unwrap_or(line).trim())
        .collect();
    if changed.is_empty() {
        return None;
    }
    let shown = changed.iter().take(3).copied().collect::<Vec<_>>().join(", ");
    let more = if changed.len() > 3 { format!(" and {} more", changed.len() - 3) } else { String::new() };
    Some(format!(
        "The source folder has uncommitted changes ({shown}{more}). Commit or stash them, then update."
    ))
}

fn check(dir: &Path) -> Result<UpdateStatus, String> {
    let installed = BUILD_COMMIT.to_string();
    git(dir, &["fetch", "--quiet", "origin", BRANCH])?;
    let latest = git(dir, &["rev-parse", &format!("origin/{BRANCH}")])?;
    let known_build = installed != "unknown" && git(dir, &["cat-file", "-e", &format!("{installed}^{{commit}}")]).is_ok();
    let main_is_in_build = known_build
        && git(dir, &["merge-base", "--is-ancestor", &format!("origin/{BRANCH}"), &installed]).is_ok();
    let update_available = needs_update(&installed, &latest, main_is_in_build);
    let new_commits = if update_available && known_build {
        git(dir, &["log", "--format=%h %s", "-n", MAX_LISTED_COMMITS, &format!("{installed}..origin/{BRANCH}")])?
            .lines()
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    let blocked_reason = if update_available {
        local_changes_reason(&git(dir, &["status", "--porcelain", "--untracked-files=no"])?)
    } else {
        None
    };
    Ok(UpdateStatus { installed_commit: installed, latest_commit: Some(latest), update_available, new_commits, blocked_reason })
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(|| check(&source_dir()?))
        .await
        .map_err(|error| format!("Update check stopped: {error}"))?
}

#[tauri::command]
pub async fn install_update() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = source_dir()?;
        let status = check(&dir)?;
        if !status.update_available {
            return Err("SocialSpace is already up to date.".into());
        }
        if let Some(reason) = status.blocked_reason {
            return Err(reason);
        }
        launch_update_script(&dir)
    })
    .await
    .map_err(|error| format!("Update stopped: {error}"))?
}

#[cfg(windows)]
fn launch_update_script(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const UPDATE_SCRIPT: &str = include_str!("update.ps1");
    let script = std::env::temp_dir().join("socialspace-update.ps1");
    std::fs::write(&script, UPDATE_SCRIPT).map_err(|error| format!("Could not prepare the update: {error}"))?;
    let app_exe = std::env::current_exe().map_err(|error| format!("Could not find the app: {error}"))?;
    Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-Source")
        .arg(dir)
        .arg("-AppPid")
        .arg(std::process::id().to_string())
        .arg("-AppExe")
        .arg(app_exe)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|error| format!("Could not start the update: {error}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn launch_update_script(_dir: &Path) -> Result<(), String> {
    Err("Installing updates is only supported on Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_is_needed_only_when_main_has_new_commits() {
        assert!(needs_update("aaa", "bbb", false));
        assert!(!needs_update("aaa", "aaa", true));
        assert!(!needs_update("feature", "main", true));
        assert!(needs_update("unknown", "bbb", false));
    }

    #[test]
    fn local_edits_block_the_install() {
        assert_eq!(local_changes_reason(""), None);
        assert_eq!(local_changes_reason("\n"), None);
        let reason = local_changes_reason(" M src/App.tsx\nM  src-tauri/src/lib.rs\n").unwrap();
        assert!(reason.contains("src/App.tsx, src-tauri/src/lib.rs"));
        let many = local_changes_reason(" M a\n M b\n M c\n M d\n M e\n").unwrap();
        assert!(many.contains("a, b, c and 2 more"));
    }

    #[test]
    fn build_records_where_it_came_from() {
        assert!(!BUILD_COMMIT.is_empty());
        assert!(Path::new(SOURCE_DIR).join("src-tauri").exists());
    }
}
