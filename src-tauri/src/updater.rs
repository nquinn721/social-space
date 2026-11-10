//! Self-update from the `main` branch of the local source repository.
//!
//! The app is built and installed from a git clone on this machine, so the build records which
//! commit it came from and which repository owns that commit. Checking for an update fetches
//! `origin/main` there (falling back to the local `main` when the fetch fails). Updating has two
//! steps, each confirmed on the Updates page or run together by `--update apply`:
//! 1. `prepare_update` builds in the background with no console windows, in the updater's own
//!    worktree (`<app local data>/updates/build`), never in the source checkout: the worktree is
//!    reset to the reviewed commit (detached, `git clean -fdx` keeping `node_modules` and the cargo
//!    target so builds stay incremental), then `npm install` and `npm run tauri:build`. So a source
//!    checkout on a feature branch or with local edits no longer blocks an update. The finished
//!    installer is recorded with its commit and SHA-256 so the app reports the update as ready.
//! 2. `install_prepared_update` verifies that installer again, then a hidden helper installs it
//!    silently once the app exits and (in the app, not headless) starts it again.
//! The UI polls `update_progress`, and the restarted app reads `take_update_result`.
//!
//! The same flow runs without a window for the Ava hub: `social-manager.exe --update check --json`
//! and `--update apply --json` print one JSON line (see [`CliReport`]) and exit.

use std::{
    ffi::OsStr,
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
/// Repository the running build came from. Its git objects are fetched into and its worktree
/// list gets the updater's build worktree; its own working tree is never touched.
pub const SOURCE_DIR: &str = env!("SOCIALSPACE_SOURCE_DIR");
/// Version of the running build; `scripts/app-version.mjs` keeps it equal to tauri.conf.json.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Bundle identifier from tauri.conf.json. App data lives in folders named after it.
pub const IDENTIFIER: &str = "com.socialmanager.desktop";
const BRANCH: &str = "main";
const REMOTE_BRANCH: &str = "origin/main";
const MAX_LISTED_COMMITS: &str = "20";
const CONF_PATH: &str = "src-tauri/tauri.conf.json";
const COMMIT_ENV: &str = "SOCIALSPACE_BUILD_COMMIT";
const SOURCE_ENV: &str = "SOCIALSPACE_SOURCE_DIR";
const DEFAULT_EXE: &str = "social-manager.exe";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// "available" (main has new commits), "ready" (they are built and waiting to install) or "up_to_date".
    state: &'static str,
    running_version: String,
    /// Version in main's tauri.conf.json, when it could be read.
    latest_version: Option<String>,
    source_dir: String,
    prepared: Option<PreparedUpdate>,
    installed_commit: String,
    latest_commit: Option<String>,
    update_available: bool,
    /// Short hash and subject of each commit on main that this build does not have.
    new_commits: Vec<String>,
    /// Why an update cannot be built or installed right now, if it cannot.
    blocked_reason: Option<String>,
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

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args).stdin(Stdio::null());
    let output = hidden(&mut command)
        .output()
        .map_err(|error| format!("Could not run git ({error}). Install Git for Windows and make sure it is on PATH."))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git {} failed: {}", args.join(" "), stderr.trim()))
    }
}

/// The source repository, or why it cannot be used.
fn source_dir() -> Result<PathBuf, String> {
    let dir = PathBuf::from(SOURCE_DIR);
    if !dir.is_dir() {
        return Err(format!("The source folder {SOURCE_DIR} is gone, so there is nothing to update from."));
    }
    git(&dir, &["rev-parse", "--git-dir"])
        .map(|_| dir)
        .map_err(|error| format!("The source folder {SOURCE_DIR} is not a git repository. {error}"))
}

/// True when `latest` (main) has commits the installed build lacks.
/// A build made from a branch that already contains main is not out of date.
fn needs_update(installed: &str, latest: &str, main_is_in_build: bool) -> bool {
    installed != latest && !main_is_in_build
}

/// Which ref counts as "main": the freshly fetched one, or the local branch when offline.
fn target_ref(fetched: bool) -> &'static str {
    if fetched {
        REMOTE_BRANCH
    } else {
        BRANCH
    }
}

/// Fetches main and returns the ref to build. Without a network the local `main` is used.
fn fetch_main(dir: &Path) -> Result<&'static str, String> {
    let fetch = git(dir, &["fetch", "--quiet", "origin", BRANCH]);
    let reference = target_ref(fetch.is_ok());
    match git(dir, &["rev-parse", "--verify", "--quiet", &format!("{reference}^{{commit}}")]) {
        Ok(_) => Ok(reference),
        Err(_) => Err(match fetch {
            Err(error) => format!("Could not fetch {BRANCH} and there is no local {BRANCH} to fall back to. {error}"),
            Ok(_) => format!("{reference} does not exist in {}.", dir.display()),
        }),
    }
}

/// The `"version"` of a tauri.conf.json.
fn conf_version(conf: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(conf).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// `name` in one of the PATH folders, as `Command` would find it.
fn find_on_path(name: &str, path_var: Option<&OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path_var?).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}

/// Building needs npm (git was already needed to get this far).
fn missing_tool_reason(npm_found: bool) -> Option<String> {
    (!npm_found).then(|| format!("npm ({NPM}) is not on PATH, so the update cannot be built. Install Node.js and try again."))
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
    let reference = fetch_main(dir)?;
    let latest = git(dir, &["rev-parse", &format!("{reference}^{{commit}}")])?;
    let latest_version = git(dir, &["show", &format!("{latest}:{CONF_PATH}")]).ok().and_then(|conf| conf_version(&conf));
    let known_build = installed != "unknown" && git(dir, &["cat-file", "-e", &format!("{installed}^{{commit}}")]).is_ok();
    let main_is_in_build = known_build && git(dir, &["merge-base", "--is-ancestor", &latest, &installed]).is_ok();
    let update_available = needs_update(&installed, &latest, main_is_in_build);
    let new_commits = if update_available && known_build {
        git(dir, &["log", "--format=%h %s", "-n", MAX_LISTED_COMMITS, &format!("{installed}..{latest}")])?
            .lines()
            .map(str::to_string)
            .collect()
    } else {
        Vec::new()
    };
    let blocked_reason = if update_available {
        missing_tool_reason(find_on_path(NPM, std::env::var_os("PATH").as_deref()).is_some())
    } else {
        None
    };
    let prepared = if update_available { prepared_for(prepared, &latest) } else { None };
    Ok(UpdateStatus {
        state: update_state(update_available, prepared.is_some()),
        running_version: version.to_string(),
        latest_version,
        source_dir: dir.display().to_string(),
        prepared,
        installed_commit: installed,
        latest_commit: Some(latest),
        update_available,
        new_commits,
        blocked_reason,
    })
}

/// Where the updater keeps its files. The app knows them from Tauri; headless runs (no Tauri app)
/// work them out the same way Tauri does on Windows: roaming and local app data + identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePaths {
    data_dir: PathBuf,
    local_data_dir: PathBuf,
}

impl UpdatePaths {
    fn from_app(app: &AppHandle) -> Result<Self, String> {
        let resolver = app.path();
        let data_dir = resolver.app_data_dir().map_err(|error| format!("Could not locate app data: {error}"))?;
        let local_data_dir = resolver.app_local_data_dir().map_err(|error| format!("Could not locate app data: {error}"))?;
        Ok(Self { data_dir, local_data_dir })
    }

    fn from_env() -> Result<Self, String> {
        let folder = |name: &str| {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(IDENTIFIER))
                .ok_or_else(|| format!("{name} is not set, so app data cannot be found."))
        };
        Ok(Self { data_dir: folder("APPDATA")?, local_data_dir: folder("LOCALAPPDATA")? })
    }

    fn data_file(&self, name: &str) -> PathBuf {
        self.data_dir.join(name)
    }

    fn build_dir(&self) -> PathBuf {
        build_worktree_dir(&self.local_data_dir)
    }
}

/// The updater's own worktree. It lives with the app's local data, outside every checkout.
pub fn build_worktree_dir(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join("updates").join("build")
}

fn check_with(paths: &UpdatePaths) -> Result<UpdateStatus, String> {
    check(&source_dir()?, APP_VERSION, read_prepared(paths))
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check_with(&UpdatePaths::from_app(&app)?))
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

/// Runs a step with no console window, streaming its output to the progress detail and the log.
fn run_logged(dir: &Path, program: &str, args: &[&str], envs: &[(&str, &str)], log: &Arc<Mutex<fs::File>>) -> Result<(), String> {
    if let Ok(mut file) = log.lock() {
        let _ = writeln!(file, "> {program} {} (in {})", args.join(" "), dir.display());
    }
    let mut command = Command::new(program);
    command.args(args).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
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

fn write_data(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, bytes).map_err(|error| format!("Could not save {}: {error}", path.display()))
}

fn read_prepared(paths: &UpdatePaths) -> Option<PreparedUpdate> {
    let contents = fs::read(paths.data_file(PREPARED_FILE)).ok()?;
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

/// Paths as git prints them and as Windows spells them can differ in slashes and case.
fn same_dir(a: &str, b: &str) -> bool {
    let normalize = |path: &str| {
        let path = path.trim().replace('\\', "/");
        let path = path.trim_end_matches('/');
        if cfg!(windows) {
            path.to_lowercase()
        } else {
            path.to_string()
        }
    };
    !a.trim().is_empty() && normalize(a) == normalize(b)
}

fn common_dir(dir: &Path) -> Result<String, String> {
    git(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
}

/// The build folder can be reused when it is a worktree of the same repository.
fn is_worktree_of(source: &Path, build: &Path) -> bool {
    build.join(".git").is_file()
        && match (common_dir(source), common_dir(build)) {
            (Ok(a), Ok(b)) => same_dir(&a, &b),
            _ => false,
        }
}

/// Kept between builds so `npm install` and cargo only redo what changed.
const KEPT_BUILD_FOLDERS: [&str; 2] = ["node_modules", "/src-tauri/target"];

fn clean_args() -> Vec<&'static str> {
    let mut args = vec!["clean", "-fdx"];
    for folder in KEPT_BUILD_FOLDERS {
        args.extend(["-e", folder]);
    }
    args
}

/// Puts the updater's worktree on exactly `commit` with no leftovers, creating it when needed.
/// Only the build folder's files change; the source checkout keeps its branch and edits.
fn prepare_worktree(source: &Path, build: &Path, commit: &str, log: &Arc<Mutex<fs::File>>) -> Result<(), String> {
    let _ = git(source, &["worktree", "prune"]);
    if is_worktree_of(source, build) {
        run_logged(build, "git", &["checkout", "--detach", "--force", commit], &[], log)?;
        run_logged(build, "git", &clean_args(), &[], log)?;
    } else {
        if build.exists() {
            fs::remove_dir_all(build).map_err(|error| format!("Could not clear the old build folder {}: {error}", build.display()))?;
        }
        if let Some(parent) = build.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }
        let target = build.display().to_string();
        run_logged(source, "git", &["worktree", "add", "--detach", "--force", &target, commit], &[], log)?;
    }
    let head = git(build, &["rev-parse", "HEAD"])?;
    if head != commit {
        return Err(format!("The build folder is on {head}, not the reviewed commit {commit}."));
    }
    Ok(())
}

/// `npm run tauri:build` stamps the commit; main from before that script existed used `tauri build`.
fn build_script_args(package_json: &str) -> Vec<&'static str> {
    let has_wrapper = serde_json::from_str::<serde_json::Value>(package_json)
        .ok()
        .and_then(|value| value.get("scripts")?.get("tauri:build").cloned())
        .is_some();
    if has_wrapper {
        vec!["run", "tauri:build"]
    } else {
        vec!["run", "tauri", "build"]
    }
}

/// Builds the reviewed main commit in the updater's worktree and records the installer.
/// Nothing is installed yet.
fn build_update(paths: &UpdatePaths, source: &Path, expected_commit: &str) -> Result<PreparedUpdate, String> {
    let log = Arc::new(Mutex::new(fs::File::create(log_path()).map_err(|error| format!("Could not create the update log: {error}"))?));
    let started = SystemTime::now();
    let build = paths.build_dir();

    begin_step(1, "Getting the latest changes");
    fetch_main(source)?;
    prepare_worktree(source, &build, expected_commit, &log)?;

    begin_step(2, "Installing dependencies");
    run_logged(&build, NPM, &["install", "--no-audit", "--no-fund"], &[], &log)?;

    begin_step(3, "Building the new version");
    remove_old_installers(&build);
    let package_json = fs::read_to_string(build.join("package.json")).unwrap_or_default();
    let source_text = source.display().to_string();
    run_logged(&build, NPM, &build_script_args(&package_json), &[(COMMIT_ENV, expected_commit), (SOURCE_ENV, &source_text)], &log)?;
    let installer = newest_installer(&build, started).ok_or("The build finished but no new installer was found.")?;

    let built_at = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or_default();
    let prepared = PreparedUpdate { commit: expected_commit.to_string(), sha256: sha256_of(&installer)?, installer: installer.display().to_string(), built_at };
    write_data(&paths.data_file(PREPARED_FILE), &serde_json::to_vec(&prepared).unwrap_or_default())?;
    set_progress(|progress| progress.state = "ready");
    Ok(prepared)
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
/// waits for it to really finish (the NSIS installer can hand off to a child process), and then,
/// unless `restart` is false (headless installs for the hub), starts the app again. Every step is
/// logged so a failed install can be explained.
fn install_script(pid: u32, installer: &Path, app_exe: &Path, log: &Path, restart: bool) -> String {
    let quote = |path: &Path| path.display().to_string().replace('\'', "''");
    let exe_name = app_exe.file_stem().map(|stem| stem.to_string_lossy().replace('\'', "''")).unwrap_or_default();
    let installer_name = installer.file_stem().map(|stem| stem.to_string_lossy().replace('\'', "''")).unwrap_or_default();
    let install = format!(
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
"#,
        log = quote(log),
        installer = quote(installer),
    );
    if !restart {
        return install + "Log 'Installed; not restarting (headless update)'\n";
    }
    install
        + &format!(
            r#"Start-Sleep -Seconds 1
$app = '{app}'
$dir = (Get-ItemProperty -Path '{uninstall_key}' -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
if ($dir) {{ $new = Join-Path $dir.Trim('"') '{exe_file}'; if (Test-Path $new) {{ $app = $new }} }}
Log ("Starting SocialSpace from " + $app)
Start-Process -FilePath $app
"#,
            app = quote(app_exe),
            uninstall_key = UNINSTALL_KEY,
            exe_file = app_exe.file_name().map(|name| name.to_string_lossy().replace('\'', "''")).unwrap_or_default(),
        )
}

/// A hidden helper waits for this process to exit, installs silently, and (when `restart`)
/// starts the app again (the old version if the install failed, which the next launch reports).
#[cfg(windows)]
fn launch_installer(installer: &Path, restart: bool) -> Result<(), String> {
    let app_exe = std::env::current_exe().map_err(|error| format!("Could not find the app: {error}"))?;
    let temp = std::env::temp_dir();
    let staged = temp.join(STAGED_INSTALLER);
    fs::copy(installer, &staged).map_err(|error| format!("Could not stage the installer: {error}"))?;
    let script_path = temp.join("socialspace-install.ps1");
    fs::write(&script_path, install_script(std::process::id(), &staged, &app_exe, &temp.join(INSTALL_LOG), restart))
        .map_err(|error| format!("Could not write the install helper: {error}"))?;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hidden(&mut command)
        .spawn()
        .map_err(|error| format!("Could not start the installer: {error}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn launch_installer(_installer: &Path, _restart: bool) -> Result<(), String> {
    Err("Installing updates is only supported on Windows.".into())
}

#[cfg(windows)]
const NPM: &str = "npm.cmd";
#[cfg(not(windows))]
const NPM: &str = "npm";

/// Verifies the prepared installer and hands it to the hidden helper. The same path serves the
/// in-app "Restart to update" (`restart`) and the headless `--update apply` (no restart).
fn install_prepared(paths: &UpdatePaths, restart: bool) -> Result<PreparedUpdate, String> {
    let prepared = read_prepared(paths).ok_or("No update is ready to install. Build it first.")?;
    let installer = PathBuf::from(&prepared.installer);
    if !installer.is_file() {
        return Err("The prepared installer is gone. Build the update again.".into());
    }
    if sha256_of(&installer)? != prepared.sha256 {
        return Err("The prepared installer changed after it was built. Build the update again.".into());
    }
    let result = UpdateResult { from_commit: BUILD_COMMIT.into(), to_commit: prepared.commit.clone(), succeeded: false };
    write_data(&paths.data_file(RESULT_FILE), &serde_json::to_vec(&result).unwrap_or_default())?;
    launch_installer(&installer, restart)?;
    let _ = fs::remove_file(paths.data_file(PREPARED_FILE));
    Ok(prepared)
}

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

/// Checks that the reviewed commit is still the one to build.
fn buildable(status: &UpdateStatus, expected_commit: &str) -> Result<(), String> {
    if !status.update_available {
        return Err("SocialSpace is already up to date.".into());
    }
    if let Some(reason) = &status.blocked_reason {
        return Err(reason.clone());
    }
    if status.latest_commit.as_deref() != Some(expected_commit) {
        return Err("Main changed since you reviewed the update. Check again and review the new changes.".into());
    }
    Ok(())
}

/// Builds the main commit the user reviewed, in the background. Progress is read with
/// `update_progress`, which reports "ready" when the installer is waiting.
#[tauri::command]
pub async fn prepare_update(app: AppHandle, expected_commit: String) -> Result<(), String> {
    if !is_commit(&expected_commit) {
        return Err("The update commit could not be verified.".into());
    }
    let paths = UpdatePaths::from_app(&app)?;
    claim_progress("Checking for changes")?;
    std::thread::spawn(move || {
        let outcome = source_dir().and_then(|dir| {
            buildable(&check(&dir, APP_VERSION, None)?, &expected_commit)?;
            build_update(&paths, &dir, &expected_commit)
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
    let paths = UpdatePaths::from_app(&app)?;
    claim_progress("Installing and restarting")?;
    if let Err(error) = install_prepared(&paths, true) {
        fail_progress(error.clone());
        return Err(error);
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
    let path = UpdatePaths::from_app(&app).ok()?.data_file(RESULT_FILE);
    let contents = fs::read(&path).ok()?;
    let _ = fs::remove_file(&path);
    let mut result: UpdateResult = serde_json::from_slice(&contents).ok()?;
    result.succeeded = result.to_commit == BUILD_COMMIT;
    Some(result)
}

// ---------------------------------------------------------------------------------------------
// Headless command line for the Ava hub.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliAction {
    Check,
    Apply,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CliRequest {
    pub action: CliAction,
    pub json: bool,
}

/// `--update check|apply [--json]` (also `--update=check`). `None` means a normal launch.
pub fn parse_cli(args: &[String]) -> Option<Result<CliRequest, String>> {
    let position = args.iter().position(|arg| arg == "--update" || arg.starts_with("--update="))?;
    Some((|| {
        let mut action = None;
        let mut json = false;
        let mut rest = args.iter().enumerate().filter(|(index, _)| *index != position).map(|(_, arg)| arg.as_str()).peekable();
        let inline = args[position].strip_prefix("--update=");
        let action_word = match inline {
            Some(word) => Some(word.to_string()),
            None => args.get(position + 1).filter(|word| !word.starts_with("--")).cloned(),
        };
        if let Some(word) = &action_word {
            action = Some(match word.as_str() {
                "check" => CliAction::Check,
                "apply" => CliAction::Apply,
                other => return Err(format!("Unknown update action '{other}'. Use --update check or --update apply.")),
            });
        }
        let mut skipped_action = inline.is_some();
        while let Some(arg) = rest.next() {
            match arg {
                "--json" => json = true,
                word if !skipped_action && Some(word) == action_word.as_deref() => skipped_action = true,
                other => return Err(format!("Unknown argument '{other}'. Usage: --update check|apply [--json]")),
            }
        }
        action
            .map(|action| CliRequest { action, json })
            .ok_or_else(|| "Missing update action. Usage: --update check|apply [--json]".to_string())
    })())
}

/// The one line `--update ... --json` prints.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliReport {
    /// "up_to_date", "available", "ready", "blocked", or "installing" (apply started the installer).
    pub state: &'static str,
    pub version: String,
    pub latest_version: Option<String>,
    pub commit: String,
    pub latest_commit: Option<String>,
    pub notes: Vec<String>,
    pub reason: Option<String>,
}

impl CliReport {
    fn blocked(reason: String) -> Self {
        Self {
            state: "blocked",
            version: APP_VERSION.into(),
            latest_version: None,
            commit: BUILD_COMMIT.into(),
            latest_commit: None,
            notes: Vec::new(),
            reason: Some(reason),
        }
    }

    fn with_blocked(mut self, reason: String) -> Self {
        self.state = "blocked";
        self.reason = Some(reason);
        self
    }
}

/// Turns a check into the hub's shape: anything that stops an update is "blocked" with a reason.
fn report_from_check(result: Result<UpdateStatus, String>) -> CliReport {
    match result {
        Err(reason) => CliReport::blocked(reason),
        Ok(status) => CliReport {
            state: if status.blocked_reason.is_some() { "blocked" } else { status.state },
            version: status.running_version,
            latest_version: status.latest_version,
            commit: status.installed_commit,
            latest_commit: status.latest_commit,
            notes: status.new_commits,
            reason: status.blocked_reason,
        },
    }
}

/// PIDs in `tasklist /FO CSV /NH` output other than `own_pid`.
fn other_pids(tasklist_csv: &str, own_pid: u32) -> Vec<u32> {
    tasklist_csv
        .lines()
        .filter(|line| line.starts_with('"'))
        .filter_map(|line| line.split("\",\"").nth(1)?.trim_matches('"').parse::<u32>().ok())
        .filter(|pid| *pid != own_pid)
        .collect()
}

fn own_exe_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()))
        .unwrap_or_else(|| DEFAULT_EXE.into())
}

/// Installing replaces the exe, so it must not run while someone has the app open.
fn other_copy_running() -> Result<bool, String> {
    let mut command = Command::new("tasklist");
    command.args(["/FI", &format!("IMAGENAME eq {}", own_exe_name()), "/FO", "CSV", "/NH"]).stdin(Stdio::null());
    let output = hidden(&mut command).output().map_err(|error| format!("Could not list running programs: {error}"))?;
    Ok(!other_pids(&String::from_utf8_lossy(&output.stdout), std::process::id()).is_empty())
}

fn apply(paths: &UpdatePaths) -> CliReport {
    let source = match source_dir() {
        Ok(dir) => dir,
        Err(reason) => return CliReport::blocked(reason),
    };
    let status = check(&source, APP_VERSION, read_prepared(paths));
    let report = report_from_check(status.clone());
    let Ok(status) = status else { return report };
    if !matches!(report.state, "available" | "ready") {
        return report;
    }
    match other_copy_running() {
        Ok(false) => {}
        Ok(true) => return report.with_blocked("Social Space is open. Close it, then apply the update.".into()),
        Err(reason) => return report.with_blocked(reason),
    }
    if status.state != "ready" {
        let Some(latest) = status.latest_commit.clone() else { return report.with_blocked("Main could not be resolved.".into()) };
        if let Err(reason) = buildable(&status, &latest).and_then(|_| build_update(paths, &source, &latest)) {
            return report.with_blocked(format!("{reason} Full log: {}", log_path().display()));
        }
    }
    match install_prepared(paths, false) {
        Ok(_) => CliReport { state: "installing", ..report },
        Err(reason) => report.with_blocked(reason),
    }
}

fn human(report: &CliReport) -> String {
    let mut lines = vec![format!("Social Space {} ({}): {}", report.version, short(&report.commit), report.state)];
    if let Some(commit) = &report.latest_commit {
        lines.push(format!("main: {} ({})", report.latest_version.as_deref().unwrap_or("?"), short(commit)));
    }
    lines.extend(report.notes.iter().map(|note| format!("  {note}")));
    if let Some(reason) = &report.reason {
        lines.push(format!("reason: {reason}"));
    }
    lines.join("\n")
}

fn short(commit: &str) -> &str {
    commit.get(..7).unwrap_or(commit)
}

/// A release build is a GUI program with no console. When it was started from a console without
/// redirected output, write to that console; when stdout is a pipe (the hub), it already works.
#[cfg(windows)]
fn connect_stdout() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> isize;
        fn SetStdHandle(which: u32, handle: isize) -> i32;
        fn AttachConsole(pid: u32) -> i32;
        fn CreateFileW(name: *const u16, access: u32, share: u32, security: *const u8, disposition: u32, flags: u32, template: isize) -> isize;
    }
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const GENERIC_READ_WRITE: u32 = 0x8000_0000 | 0x4000_0000;
    const FILE_SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    const OPEN_EXISTING: u32 = 3;
    const INVALID: isize = -1;
    // SAFETY: plain Win32 calls with valid constant arguments and a NUL-terminated UTF-16 name.
    unsafe {
        let current = GetStdHandle(STD_OUTPUT_HANDLE);
        if current != 0 && current != INVALID {
            return;
        }
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        let name: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
        let console = CreateFileW(name.as_ptr(), GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, std::ptr::null(), OPEN_EXISTING, 0, 0);
        if console != INVALID {
            SetStdHandle(STD_OUTPUT_HANDLE, console);
            SetStdHandle(STD_ERROR_HANDLE, console);
        }
    }
}

#[cfg(not(windows))]
fn connect_stdout() {}

/// Runs `--update ...` without opening a window and returns the process exit code:
/// 0 whenever a report was printed (the state says what happened), 2 for bad arguments.
pub fn run_cli(request: Result<CliRequest, String>) -> i32 {
    connect_stdout();
    let request = match request {
        Ok(request) => request,
        Err(message) => {
            eprintln!("{message}");
            return 2;
        }
    };
    let report = match UpdatePaths::from_env() {
        Err(reason) => CliReport::blocked(reason),
        Ok(paths) => match request.action {
            CliAction::Check => report_from_check(check_with(&paths)),
            CliAction::Apply => apply(&paths),
        },
    };
    let text = if request.json { serde_json::to_string(&report).unwrap_or_default() } else { human(&report) };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{text}");
    let _ = stdout.flush();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    fn status(state: &'static str, blocked: Option<&str>) -> UpdateStatus {
        UpdateStatus {
            state,
            running_version: "0.2.0".into(),
            latest_version: Some("0.3.0".into()),
            source_dir: "D:/repo".into(),
            prepared: None,
            installed_commit: "a".repeat(40),
            latest_commit: Some("b".repeat(40)),
            update_available: state != "up_to_date",
            new_commits: vec!["bbbbbbb Add video library".into()],
            blocked_reason: blocked.map(str::to_string),
        }
    }

    #[test]
    fn update_is_needed_only_when_main_has_new_commits() {
        assert!(needs_update("aaa", "bbb", false));
        assert!(!needs_update("aaa", "aaa", true));
        assert!(!needs_update("feature", "main", true));
        assert!(needs_update("unknown", "bbb", false));
    }

    #[test]
    fn offline_checks_fall_back_to_local_main() {
        assert_eq!(target_ref(true), "origin/main");
        assert_eq!(target_ref(false), "main");
    }

    #[test]
    fn main_version_comes_from_tauri_conf() {
        assert_eq!(conf_version(r#"{"productName":"Social Space","version":"0.3.1"}"#).as_deref(), Some("0.3.1"));
        assert_eq!(conf_version("not json"), None);
        assert_eq!(conf_version("{}"), None);
    }

    #[test]
    fn missing_npm_blocks_the_build() {
        assert_eq!(missing_tool_reason(true), None);
        assert!(missing_tool_reason(false).unwrap().contains("npm"));
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("tool.cmd"), b"").unwrap();
        let path = std::env::join_paths([Path::new("Z:/nowhere"), dir.path()]).unwrap();
        assert_eq!(find_on_path("tool.cmd", Some(&path)), Some(dir.path().join("tool.cmd")));
        assert_eq!(find_on_path("other.cmd", Some(&path)), None);
        assert_eq!(find_on_path("tool.cmd", None), None);
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
    fn only_the_reviewed_newest_main_is_built() {
        let latest = "b".repeat(40);
        assert!(buildable(&status("available", None), &latest).is_ok());
        assert!(buildable(&status("available", None), &"c".repeat(40)).unwrap_err().contains("Main changed"));
        assert!(buildable(&status("up_to_date", None), &latest).unwrap_err().contains("up to date"));
        assert_eq!(buildable(&status("available", Some("npm missing")), &latest).unwrap_err(), "npm missing");
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
        let script = install_script(42, Path::new(r"C:\Temp\socialspace-update-setup.exe"), Path::new(r"C:\Apps\Social Manager\social-manager.exe"), Path::new(r"C:\Temp\install.log"), true);
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
    fn headless_installs_do_not_restart_the_app() {
        let script = install_script(42, Path::new(r"C:\Temp\socialspace-update-setup.exe"), Path::new(r"C:\Apps\Social Space\social-manager.exe"), Path::new(r"C:\Temp\install.log"), false);
        assert!(script.contains("-ArgumentList '/S' -PassThru -Wait"));
        assert!(!script.contains("Start-Process -FilePath $app"));
        assert!(script.contains("not restarting"));
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
        // SOURCE_DIR is the repository that owns the objects, never a worktree of it.
        assert!(Path::new(SOURCE_DIR).join(".git").is_dir(), "{SOURCE_DIR} should be the main checkout");
    }

    #[test]
    fn version_and_identifier_match_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], APP_VERSION);
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[test]
    fn the_build_worktree_lives_in_local_app_data() {
        let local = Path::new(r"C:\Users\me\AppData\Local\com.socialmanager.desktop");
        assert_eq!(build_worktree_dir(local), local.join("updates").join("build"));
        let paths = UpdatePaths { data_dir: PathBuf::from("roaming"), local_data_dir: local.to_path_buf() };
        assert_eq!(paths.build_dir(), local.join("updates").join("build"));
        assert_eq!(paths.data_file(PREPARED_FILE), Path::new("roaming").join(PREPARED_FILE));
    }

    #[test]
    fn dependencies_and_cargo_output_survive_the_reset() {
        assert_eq!(clean_args(), ["clean", "-fdx", "-e", "node_modules", "-e", "/src-tauri/target"]);
    }

    #[test]
    fn worktree_paths_compare_like_windows_does() {
        assert!(same_dir("D:/Projects/SocialManager/.git", r"D:\Projects\SocialManager\.git\"));
        assert_eq!(same_dir("D:/Projects/A/.git", "d:/projects/a/.git"), cfg!(windows));
        assert!(!same_dir("D:/Projects/A/.git", "D:/Projects/B/.git"));
        assert!(!same_dir("", ""));
    }

    #[test]
    fn the_stamping_build_script_is_used_when_main_has_it() {
        assert_eq!(build_script_args(r#"{"scripts":{"tauri:build":"node scripts/tauri-build.mjs"}}"#), ["run", "tauri:build"]);
        assert_eq!(build_script_args(r#"{"scripts":{"tauri":"tauri"}}"#), ["run", "tauri", "build"]);
        assert_eq!(build_script_args(""), ["run", "tauri", "build"]);
    }

    #[test]
    fn cli_arguments_are_parsed() {
        assert_eq!(parse_cli(&args(&[])), None);
        assert_eq!(parse_cli(&args(&["--something-else"])), None);
        assert_eq!(parse_cli(&args(&["--update", "check", "--json"])), Some(Ok(CliRequest { action: CliAction::Check, json: true })));
        assert_eq!(parse_cli(&args(&["--json", "--update", "apply"])), Some(Ok(CliRequest { action: CliAction::Apply, json: true })));
        assert_eq!(parse_cli(&args(&["--update=check"])), Some(Ok(CliRequest { action: CliAction::Check, json: false })));
        assert!(parse_cli(&args(&["--update"])).unwrap().unwrap_err().contains("Missing"));
        assert!(parse_cli(&args(&["--update", "--json"])).unwrap().unwrap_err().contains("Missing"));
        assert!(parse_cli(&args(&["--update", "install"])).unwrap().unwrap_err().contains("Unknown update action"));
        assert!(parse_cli(&args(&["--update", "check", "extra"])).unwrap().unwrap_err().contains("Unknown argument"));
    }

    #[test]
    fn cli_report_has_the_hub_shape() {
        let report = report_from_check(Ok(status("available", None)));
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&report).unwrap()).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 7);
        for key in ["state", "version", "latestVersion", "commit", "latestCommit", "notes", "reason"] {
            assert!(keys.contains(&key), "missing {key}");
        }
        assert_eq!(json["state"], "available");
        assert_eq!(json["latestVersion"], "0.3.0");
        assert_eq!(json["notes"][0], "bbbbbbb Add video library");
        assert!(json["reason"].is_null());
        assert!(!serde_json::to_string(&report).unwrap().contains('\n'), "one line");
    }

    #[test]
    fn anything_that_stops_an_update_is_reported_as_blocked() {
        assert_eq!(report_from_check(Ok(status("up_to_date", None))).state, "up_to_date");
        assert_eq!(report_from_check(Ok(status("ready", None))).state, "ready");
        let blocked = report_from_check(Ok(status("available", Some("npm missing"))));
        assert_eq!((blocked.state, blocked.reason.as_deref()), ("blocked", Some("npm missing")));
        let failed = report_from_check(Err("The source folder X is gone".into()));
        assert_eq!(failed.state, "blocked");
        assert_eq!(failed.latest_commit, None);
        assert_eq!(failed.version, APP_VERSION);
        let open = report_from_check(Ok(status("available", None))).with_blocked("open".into());
        assert_eq!((open.state, open.latest_commit.is_some()), ("blocked", true));
    }

    #[test]
    fn other_running_copies_are_found() {
        let csv = "\"social-manager.exe\",\"1200\",\"Console\",\"1\",\"80,000 K\"\r\n\"social-manager.exe\",\"77\",\"Console\",\"1\",\"9,000 K\"\r\n";
        assert_eq!(other_pids(csv, 77), vec![1200]);
        assert!(other_pids("\"social-manager.exe\",\"77\",\"Console\",\"1\",\"9,000 K\"", 77).is_empty());
        assert!(other_pids("INFO: No tasks are running which match the specified criteria.", 77).is_empty());
    }

    #[test]
    fn human_output_summarises_the_report() {
        let text = human(&report_from_check(Ok(status("available", None))));
        assert!(text.contains("available") && text.contains("bbbbbbb Add video library") && text.contains("0.3.0"));
    }
}
