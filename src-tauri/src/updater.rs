//! Self-update from the `main` branch of the local source checkout.
//!
//! The app is built and installed from a git clone on this machine, so the build
//! records which commit it came from and which folder it was built in. Checking
//! for an update fetches `origin/main` in that folder. Updating has two steps, each one
//! confirmed on the Updates page:
//! 1. `prepare_update` builds in the background with no console windows: fetch and check out
//!    origin/main (detached), `npm install`, `tauri build`. The finished installer is recorded
//!    with its commit and SHA-256 so the app reports the update as ready.
//! 2. `install_prepared_update` verifies that installer again, then a hidden helper installs it
//!    silently once the app exits and starts it again.
//! The UI polls `update_progress`, and the restarted app reads `take_update_result`.

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
    /// "available" (main has new commits), "ready" (they are built and waiting to install) or "up_to_date".
    state: &'static str,
    running_version: String,
    source_dir: String,
    prepared: Option<PreparedUpdate>,
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

/// A build of main that finished and is waiting to be installed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedUpdate {
    commit: String,
    installer: String,
    sha256: String,
    /// Seconds since the Unix epoch.
    built_at: u64,
}

fn update_state(update_available: bool, prepared_matches: bool) -> &'static str {
    match (update_available, prepared_matches) {
        (false, _) => "up_to_date",
        (true, true) => "ready",
        (true, false) => "available",
    }
}

/// A prepared build only counts while it is still the newest main and its installer is still there.
fn prepared_for(prepared: Option<PreparedUpdate>, latest: &str) -> Option<PreparedUpdate> {
    prepared.filter(|item| item.commit == latest && Path::new(&item.installer).is_file())
}

fn check(dir: &Path, version: &str, prepared: Option<PreparedUpdate>) -> Result<UpdateStatus, String> {
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
    let prepared = if update_available { prepared_for(prepared, &latest) } else { None };
    Ok(UpdateStatus {
        state: update_state(update_available, prepared.is_some()),
        running_version: version.to_string(),
        source_dir: dir.display().to_string(),
        prepared,
        installed_commit: installed,
        latest_commit: Some(latest),
        update_available,
        new_commits,
        blocked_reason,
    })
}

fn check_app(app: &AppHandle) -> Result<UpdateStatus, String> {
    check(&source_dir()?, &app.package_info().version.to_string(), read_prepared(app))
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check_app(&app))
        .await
        .map_err(|error| format!("Update check stopped: {error}"))?
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// "idle", "running" (building), "ready" (built, waiting to install), "restarting" or "failed".
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

const TOTAL_STEPS: u8 = 3;
const RESULT_FILE: &str = "last-update.json";
const PREPARED_FILE: &str = "prepared-update.json";
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
    fs::read_dir(installer_dir(dir))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with("-setup.exe"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .filter(|(modified, _)| *modified >= since)
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(name))
        .map_err(|error| format!("Could not locate app data: {error}"))
}

fn result_path(app: &AppHandle) -> Result<PathBuf, String> {
    data_file(app, RESULT_FILE)
}

fn write_data(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, bytes).map_err(|error| format!("Could not save {}: {error}", path.display()))
}

fn read_prepared(app: &AppHandle) -> Option<PreparedUpdate> {
    let contents = fs::read(data_file(app, PREPARED_FILE).ok()?).ok()?;
    serde_json::from_slice(&contents).ok()
}

fn sha256_of(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).map_err(|error| format!("Could not read the installer: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("Could not read the installer: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

fn log_path() -> PathBuf {
    std::env::temp_dir().join("socialspace-update.log")
}

fn installer_dir(dir: &Path) -> PathBuf {
    dir.join("src-tauri/target/release/bundle/nsis")
}

/// Old installers pile up with every build; only the one being built is needed. Installing itself
/// overwrites the app in place, so no old copy of the app is left behind.
fn remove_old_installers(dir: &Path) {
    let Ok(entries) = fs::read_dir(installer_dir(dir)) else { return };
    for entry in entries.filter_map(Result::ok) {
        if entry.file_name().to_string_lossy().ends_with("-setup.exe") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Builds the reviewed main commit and records the installer. Nothing is installed yet.
fn build_update(app: &AppHandle, dir: &Path, expected_commit: &str) -> Result<(), String> {
    let log = Arc::new(Mutex::new(fs::File::create(log_path()).map_err(|error| format!("Could not create the update log: {error}"))?));
    let started = SystemTime::now();

    begin_step(1, "Getting the latest changes");
    run_logged(dir, "git", &["fetch", "origin", BRANCH], &log)?;
    // Check out exactly the reviewed commit, detached, so it also works in a worktree while
    // `main` is checked out somewhere else.
    run_logged(dir, "git", &["checkout", "--detach", expected_commit], &log)?;
    let new_commit = git(dir, &["rev-parse", "HEAD"])?;
    if new_commit != expected_commit {
        return Err(format!("The source folder is on {new_commit}, not the reviewed commit {expected_commit}."));
    }

    begin_step(2, "Installing dependencies");
    run_logged(dir, NPM, &["install", "--no-audit", "--no-fund"], &log)?;

    begin_step(3, "Building the new version");
    remove_old_installers(dir);
    run_logged(dir, NPM, &["run", "tauri", "build"], &log)?;
    let installer = newest_installer(dir, started).ok_or("The build finished but no new installer was found.")?;

    let built_at = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or_default();
    let prepared = PreparedUpdate { commit: new_commit, sha256: sha256_of(&installer)?, installer: installer.display().to_string(), built_at };
    write_data(&data_file(app, PREPARED_FILE)?, &serde_json::to_vec(&prepared).unwrap_or_default())?;
    set_progress(|progress| progress.state = "ready");
    Ok(())
}

/// Where the installer is copied before installing, so a build started by the restarted app
/// cannot delete it while it runs.
const STAGED_INSTALLER: &str = "socialspace-update-setup.exe";
const INSTALL_LOG: &str = "socialspace-install.log";
/// The uninstall entry the installer writes, named after `productName` in tauri.conf.json.
/// Renaming the app from Social Manager moved its install folder, so the restart reads the
/// install location from here instead of reusing the old exe path, which the installer removes.
const UNINSTALL_KEY: &str = r"HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Social Space";

/// The script the hidden helper runs. It waits for the app to close, runs the installer and
/// waits for it to really finish (the NSIS installer can hand off to a child process), and only
/// then starts the app again. Every step is logged so a failed install can be explained.
fn install_script(pid: u32, installer: &Path, app_exe: &Path, log: &Path) -> String {
    let quote = |path: &Path| path.display().to_string().replace('\'', "''");
    let exe_name = app_exe.file_stem().map(|stem| stem.to_string_lossy().replace('\'', "''")).unwrap_or_default();
    let installer_name = installer.file_stem().map(|stem| stem.to_string_lossy().replace('\'', "''")).unwrap_or_default();
    format!(
        r#"$log = '{log}'
function Log($m) {{ Add-Content -Path $log -Value ("{{0:o}} {{1}}" -f (Get-Date), $m) }}
Log 'Waiting for SocialSpace to close'
$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue
if ($p -and -not $p.WaitForExit(60000)) {{ Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }}
Get-Process -Name '{exe_name}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Log 'Running the installer'
$i = Start-Process -FilePath '{installer}' -ArgumentList '/S' -PassThru -Wait
Log ("Installer exited with " + $i.ExitCode)
for ($n = 0; $n -lt 180 -and (Get-Process -Name '{installer_name}' -ErrorAction SilentlyContinue); $n++) {{ Start-Sleep -Seconds 1 }}
Start-Sleep -Seconds 1
$app = '{app}'
$dir = (Get-ItemProperty -Path '{uninstall_key}' -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
if ($dir) {{ $new = Join-Path $dir.Trim('"') '{exe_file}'; if (Test-Path $new) {{ $app = $new }} }}
Log ("Starting SocialSpace from " + $app)
Start-Process -FilePath $app
"#,
        log = quote(log),
        installer = quote(installer),
        app = quote(app_exe),
        uninstall_key = UNINSTALL_KEY,
        exe_file = app_exe.file_name().map(|name| name.to_string_lossy().replace('\'', "''")).unwrap_or_default(),
    )
}

/// A hidden helper waits for this process to exit, installs silently, and starts the app again
/// (the old version if the install failed, which the next launch reports).
#[cfg(windows)]
fn launch_installer(installer: &Path) -> Result<(), String> {
    let app_exe = std::env::current_exe().map_err(|error| format!("Could not find the app: {error}"))?;
    let temp = std::env::temp_dir();
    let staged = temp.join(STAGED_INSTALLER);
    fs::copy(installer, &staged).map_err(|error| format!("Could not stage the installer: {error}"))?;
    let script_path = temp.join("socialspace-install.ps1");
    fs::write(&script_path, install_script(std::process::id(), &staged, &app_exe, &temp.join(INSTALL_LOG)))
        .map_err(|error| format!("Could not write the install helper: {error}"))?;
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script_path);
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

fn claim_progress(label: &str) -> Result<(), String> {
    let mut guard = PROGRESS.lock().map_err(|_| "Update state is unavailable.")?;
    let current = guard.get_or_insert_with(UpdateProgress::default);
    if matches!(current.state, "running" | "restarting") {
        return Err("An update is already running.".into());
    }
    *current = UpdateProgress { state: "running", label: label.into(), ..UpdateProgress::default() };
    Ok(())
}

fn fail_progress(error: String) {
    set_progress(|progress| {
        progress.state = "failed";
        progress.error = Some(format!("{error} Full log: {}", log_path().display()));
    });
}

fn is_commit(value: &str) -> bool {
    value.len() == 40 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// Builds the main commit the user reviewed, in the background. Progress is read with
/// `update_progress`, which reports "ready" when the installer is waiting.
#[tauri::command]
pub async fn prepare_update(app: AppHandle, expected_commit: String) -> Result<(), String> {
    if !is_commit(&expected_commit) {
        return Err("The update commit could not be verified.".into());
    }
    claim_progress("Checking for changes")?;
    std::thread::spawn(move || {
        let outcome = source_dir().and_then(|dir| {
            let status = check(&dir, "", None)?;
            if !status.update_available {
                return Err("SocialSpace is already up to date.".into());
            }
            if let Some(reason) = status.blocked_reason {
                return Err(reason);
            }
            if status.latest_commit.as_deref() != Some(expected_commit.as_str()) {
                return Err("Main changed since you reviewed the update. Check again and review the new changes.".into());
            }
            build_update(&app, &dir, &expected_commit)
        });
        if let Err(error) = outcome {
            fail_progress(error);
        }
    });
    Ok(())
}

/// Verifies the prepared installer again, then closes the app, installs it silently and restarts.
#[tauri::command]
pub async fn install_prepared_update(app: AppHandle) -> Result<(), String> {
    let prepared = read_prepared(&app).ok_or("No update is ready to install. Build it first.")?;
    let installer = PathBuf::from(&prepared.installer);
    if !installer.is_file() {
        return Err("The prepared installer is gone. Build the update again.".into());
    }
    if sha256_of(&installer)? != prepared.sha256 {
        return Err("The prepared installer changed after it was built. Build the update again.".into());
    }
    claim_progress("Installing and restarting")?;
    let result = UpdateResult { from_commit: BUILD_COMMIT.into(), to_commit: prepared.commit, succeeded: false };
    let outcome = result_path(&app)
        .and_then(|path| write_data(&path, &serde_json::to_vec(&result).unwrap_or_default()))
        .and_then(|_| launch_installer(&installer));
    if let Err(error) = outcome {
        fail_progress(error.clone());
        return Err(error);
    }
    if let Ok(path) = data_file(&app, PREPARED_FILE) {
        let _ = fs::remove_file(path);
    }
    set_progress(|progress| progress.state = "restarting");
    std::thread::spawn(move || {
        // Give the window a moment to show "restarting" before the installer replaces the app.
        std::thread::sleep(Duration::from_millis(1500));
        app.exit(0);
    });
    Ok(())
}

/// Restarts the running app. This does not install anything.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart()
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
    fn a_built_update_is_ready_only_for_the_newest_main() {
        assert_eq!(update_state(false, false), "up_to_date");
        assert_eq!(update_state(true, false), "available");
        assert_eq!(update_state(true, true), "ready");

        let dir = tempfile::tempdir().unwrap();
        let installer = dir.path().join("SocialSpace-setup.exe");
        fs::write(&installer, b"installer").unwrap();
        let prepared = PreparedUpdate { commit: "b".repeat(40), installer: installer.display().to_string(), sha256: String::new(), built_at: 1 };
        assert!(prepared_for(Some(prepared.clone()), &"b".repeat(40)).is_some());
        assert!(prepared_for(Some(prepared.clone()), &"c".repeat(40)).is_none(), "main moved on since the build");
        fs::remove_file(&installer).unwrap();
        assert!(prepared_for(Some(prepared), &"b".repeat(40)).is_none(), "installer was deleted");
    }

    #[test]
    fn only_full_commit_hashes_are_built() {
        assert!(is_commit(&"a1".repeat(20)));
        assert!(!is_commit("a1b2c3d"));
        assert!(!is_commit(&"z".repeat(40)));
        assert!(!is_commit("origin/main; rm -rf"));
    }

    #[test]
    fn installers_are_fingerprinted() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("setup.exe");
        fs::write(&file, b"abc").unwrap();
        assert_eq!(sha256_of(&file).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn old_installers_are_removed_before_a_build() {
        let dir = tempfile::tempdir().unwrap();
        let nsis = installer_dir(dir.path());
        fs::create_dir_all(&nsis).unwrap();
        fs::write(nsis.join("Social Manager_0.1.0_x64-setup.exe"), b"old").unwrap();
        fs::write(nsis.join("notes.txt"), b"keep").unwrap();
        remove_old_installers(dir.path());
        assert!(!nsis.join("Social Manager_0.1.0_x64-setup.exe").exists());
        assert!(nsis.join("notes.txt").exists());
    }

    #[test]
    fn the_app_restarts_only_after_the_installer_is_done() {
        let script = install_script(42, Path::new(r"C:\Temp\socialspace-update-setup.exe"), Path::new(r"C:\Apps\Social Manager\social-manager.exe"), Path::new(r"C:\Temp\install.log"));
        let install = script.find("-ArgumentList '/S' -PassThru -Wait").unwrap();
        let wait_for_children = script.find("Get-Process -Name 'socialspace-update-setup'").unwrap();
        let relaunch = script.find("Start-Process -FilePath $app").unwrap();
        assert!(install < wait_for_children && wait_for_children < relaunch);
        assert!(script.contains(r"$app = 'C:\Apps\Social Manager\social-manager.exe'"), "falls back to the running exe");
        assert!(script.contains(r"Uninstall\Social Space' -Name InstallLocation"), "prefers the renamed install folder");
        assert!(script.contains(r#"Join-Path $dir.Trim('"') 'social-manager.exe'"#));
        assert!(script.contains("Get-Process -Id 42"));
        assert!(script.contains("Get-Process -Name 'social-manager'"), "other open windows are closed first");
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
