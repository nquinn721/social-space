//! Self-update from the `main` branch of the local source checkout.
//!
//! The app is built and installed from a git clone on this machine, so the build
//! records which commit it came from and which folder it was built in. Checking
//! for an update fetches `origin/main` in that folder. Installing runs entirely in the
//! background with no console windows: fetch and check out origin/main (detached), `npm install`, `tauri build`, then a hidden
//! helper installs the new build silently once the app exits and starts it again. The
//! UI polls `update_progress`, and the restarted app reads `take_update_result`.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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

/// The updater moves its source folder to origin/main, so it must not be a checkout someone
/// is working in on another branch. `main` or a detached checkout (the dedicated app folder) is fine.
fn other_branch_reason(branch: &str) -> Option<String> {
    let branch = branch.trim();
    if branch.is_empty() || branch == BRANCH {
        None
    } else {
        Some(format!(
            "The source folder {SOURCE_DIR} is on branch {branch}, not {BRANCH}. Updating would move it off that branch, so it was skipped."
        ))
    }
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
        let branch = git(dir, &["branch", "--show-current"])?;
        other_branch_reason(&branch)
            .or(local_changes_reason(&git(dir, &["status", "--porcelain", "--untracked-files=no"])?))
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// "idle", "running", "restarting" or "failed".
    state: &'static str,
    step: u8,
    total_steps: u8,
    label: String,
    /// Latest line of build output, so the user can see it is moving.
    detail: String,
    error: Option<String>,
}

impl Default for UpdateProgress {
    fn default() -> Self {
        Self { state: "idle", step: 0, total_steps: TOTAL_STEPS, label: String::new(), detail: String::new(), error: None }
    }
}

/// Written just before the app restarts into the new build, read once by the new build.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    from_commit: String,
    to_commit: String,
    #[serde(default)]
    succeeded: bool,
}

const TOTAL_STEPS: u8 = 4;
const RESULT_FILE: &str = "last-update.json";
static PROGRESS: Mutex<Option<UpdateProgress>> = Mutex::new(None);

fn progress() -> UpdateProgress {
    PROGRESS.lock().map(|guard| guard.clone().unwrap_or_default()).unwrap_or_default()
}

fn set_progress(update: impl FnOnce(&mut UpdateProgress)) {
    if let Ok(mut guard) = PROGRESS.lock() {
        update(guard.get_or_insert_with(UpdateProgress::default));
    }
}

fn begin_step(step: u8, label: &str) {
    set_progress(|progress| {
        progress.step = step;
        progress.label = label.into();
        progress.detail.clear();
    });
}

/// Removes terminal colour codes and progress-bar noise from a line of build output.
fn clean_output_line(line: &str) -> String {
    let mut cleaned = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if c == '\r' {
            cleaned.clear();
        } else if !c.is_control() {
            cleaned.push(c);
        }
    }
    let cleaned = cleaned.trim();
    cleaned.chars().take(200).collect()
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Runs a step with no console window, streaming its output to the progress detail and the log.
fn run_logged(dir: &Path, program: &str, args: &[&str], log: &Arc<Mutex<fs::File>>) -> Result<(), String> {
    let mut command = Command::new(program);
    command.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = hidden(&mut command)
        .spawn()
        .map_err(|error| format!("Could not run {program}: {error}"))?;
    let readers: Vec<_> = [child.stdout.take().map(|out| Box::new(out) as Box<dyn Read + Send>), child.stderr.take().map(|err| Box::new(err) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
        .map(|stream| {
            let log = Arc::clone(log);
            std::thread::spawn(move || {
                let mut tail = String::new();
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if let Ok(mut file) = log.lock() {
                        let _ = writeln!(file, "{line}");
                    }
                    let cleaned = clean_output_line(&line);
                    if !cleaned.is_empty() {
                        set_progress(|progress| progress.detail = cleaned.clone());
                        tail = cleaned;
                    }
                }
                tail
            })
        })
        .collect();
    let status = child.wait().map_err(|error| format!("{program} stopped: {error}"))?;
    let tails: Vec<String> = readers.into_iter().filter_map(|reader| reader.join().ok()).filter(|tail| !tail.is_empty()).collect();
    if status.success() {
        Ok(())
    } else {
        let last = tails.last().cloned().unwrap_or_default();
        Err(format!("'{program} {}' failed ({status}). {last}", args.join(" ")).trim().to_string())
    }
}

fn newest_installer(dir: &Path, since: SystemTime) -> Option<PathBuf> {
    fs::read_dir(dir.join("src-tauri/target/release/bundle/nsis"))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with("-setup.exe"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .filter(|(modified, _)| *modified >= since)
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn result_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(RESULT_FILE))
        .map_err(|error| format!("Could not locate app data: {error}"))
}

fn run_update(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let log_path = std::env::temp_dir().join("socialspace-update.log");
    let log = Arc::new(Mutex::new(fs::File::create(&log_path).map_err(|error| format!("Could not create the update log: {error}"))?));
    let started = SystemTime::now();

    begin_step(1, "Getting the latest changes");
    run_logged(dir, "git", &["fetch", "origin", BRANCH], &log)?;
    // Detached, so it works in a worktree even while `main` is checked out somewhere else.
    run_logged(dir, "git", &["checkout", "--detach", &format!("origin/{BRANCH}")], &log)?;
    let new_commit = git(dir, &["rev-parse", "HEAD"])?;

    begin_step(2, "Installing dependencies");
    run_logged(dir, NPM, &["install", "--no-audit", "--no-fund"], &log)?;

    begin_step(3, "Building the new version");
    run_logged(dir, NPM, &["run", "tauri", "build"], &log)?;
    let installer = newest_installer(dir, started).ok_or("The build finished but no new installer was found.")?;

    begin_step(4, "Installing and restarting");
    let result = UpdateResult { from_commit: BUILD_COMMIT.into(), to_commit: new_commit, succeeded: false };
    let path = result_path(app)?;
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, serde_json::to_vec(&result).unwrap_or_default()).map_err(|error| format!("Could not record the update: {error}"))?;
    launch_installer(&installer)?;
    set_progress(|progress| progress.state = "restarting");
    // Give the window a moment to show "restarting" before the installer replaces the app.
    std::thread::sleep(Duration::from_millis(1500));
    app.exit(0);
    Ok(())
}

/// A hidden helper waits for this process to exit, installs silently, and starts the app again
/// (the old version if the install failed, which the next launch reports).
#[cfg(windows)]
fn launch_installer(installer: &Path) -> Result<(), String> {
    let app_exe = std::env::current_exe().map_err(|error| format!("Could not find the app: {error}"))?;
    let quote = |path: &Path| path.display().to_string().replace('\'', "''");
    let script = format!(
        "$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($p) {{ if (-not $p.WaitForExit(60000)) {{ Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }} }}; \
         Start-Process -FilePath '{installer}' -ArgumentList '/S' -Wait; Start-Process -FilePath '{app}'",
        pid = std::process::id(),
        installer = quote(installer),
        app = quote(&app_exe),
    );
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", &script]);
    hidden(&mut command)
        .spawn()
        .map_err(|error| format!("Could not start the installer: {error}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn launch_installer(_installer: &Path) -> Result<(), String> {
    Err("Installing updates is only supported on Windows.".into())
}

#[cfg(windows)]
const NPM: &str = "npm.cmd";
#[cfg(not(windows))]
const NPM: &str = "npm";

/// Starts the update in the background. Progress is read with `update_progress`.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    {
        let mut guard = PROGRESS.lock().map_err(|_| "Update state is unavailable.")?;
        let current = guard.get_or_insert_with(UpdateProgress::default);
        if matches!(current.state, "running" | "restarting") {
            return Err("An update is already running.".into());
        }
        *current = UpdateProgress { state: "running", label: "Checking for changes".into(), ..UpdateProgress::default() };
    }
    std::thread::spawn(move || {
        let outcome = source_dir().and_then(|dir| {
            let status = check(&dir)?;
            if !status.update_available {
                return Err("SocialSpace is already up to date.".into());
            }
            if let Some(reason) = status.blocked_reason {
                return Err(reason);
            }
            run_update(&app, &dir)
        });
        if let Err(error) = outcome {
            set_progress(|progress| {
                progress.state = "failed";
                progress.error = Some(format!("{error} Full log: {}", std::env::temp_dir().join("socialspace-update.log").display()));
            });
        }
    });
    Ok(())
}

#[tauri::command]
pub fn update_progress() -> UpdateProgress {
    progress()
}

/// Returns the outcome of the update that restarted the app, once, then forgets it.
#[tauri::command]
pub fn take_update_result(app: AppHandle) -> Option<UpdateResult> {
    let path = result_path(&app).ok()?;
    let contents = fs::read(&path).ok()?;
    let _ = fs::remove_file(&path);
    let mut result: UpdateResult = serde_json::from_slice(&contents).ok()?;
    result.succeeded = result.to_commit == BUILD_COMMIT;
    Some(result)
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
    fn work_on_another_branch_blocks_the_install() {
        assert_eq!(other_branch_reason(""), None);
        assert_eq!(other_branch_reason("main\n"), None);
        assert!(other_branch_reason("brand-hierarchy").unwrap().contains("on branch brand-hierarchy"));
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
    fn build_output_is_cleaned_for_display() {
        assert_eq!(clean_output_line("\u{1b}[32m    Compiling\u{1b}[0m tauri v2.8.0"), "Compiling tauri v2.8.0");
        assert_eq!(clean_output_line("old progress\rnew progress  "), "new progress");
        assert_eq!(clean_output_line(&"x".repeat(500)).len(), 200);
    }

    #[test]
    fn progress_starts_idle() {
        let idle = UpdateProgress::default();
        assert_eq!(idle.state, "idle");
        assert_eq!(idle.total_steps, TOTAL_STEPS);
    }

    #[test]
    fn build_records_where_it_came_from() {
        assert!(!BUILD_COMMIT.is_empty());
        assert!(Path::new(SOURCE_DIR).join("src-tauri").exists());
    }
}
