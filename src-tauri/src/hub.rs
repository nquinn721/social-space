//! What the Ava hub's update contract needs beyond building updates (updater.rs does that):
//!
//! - Identity: `social-manager.exe --version --json` prints [`VersionInfo`] (the fixed hub id, the
//!   version and the commit stamped into the build).
//! - Managed mode: while Ava manages updates it writes `%APPDATA%\<identifier>\hub-managed.json`
//!   (`{"managedBy": "Ava", "avaPath", "since"}`) and starts the app with `--hub`. Then the app never
//!   checks for or offers updates itself; Settings says "Updates managed by Ava". Deleting the
//!   marker brings the app's own updater back. The marker sits in the app's data folder, which no
//!   installer or update touches.
//! - Swapping the program: a headless install replaces `social-manager.exe` in place (the running
//!   file is renamed aside, which Windows allows), proves the new one starts and reports the
//!   expected commit, and keeps the replaced program in `updates/previous` for `--update rollback`.
//!   Any failure puts the old program back.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::updater::{APP_VERSION, BUILD_COMMIT, IDENTIFIER};

/// The id in hub-app.json. It never changes.
pub const HUB_ID: &str = "social-space";
pub const MARKER_NAME: &str = "hub-managed.json";
pub const HUB_FLAG: &str = "--hub";
const DEFAULT_MANAGER: &str = "Ava";
/// The program keeps this name in every install folder.
pub const EXE_NAME: &str = "social-manager.exe";
const PREVIOUS_INFO: &str = "previous.json";
const STAGING_EXE: &str = "staging.exe";
/// How long the swapped-in program gets to answer `--version --json`.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);

/// What `--version --json` prints.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VersionInfo {
    pub id: String,
    pub version: String,
    pub commit: String,
}

pub fn version_info() -> VersionInfo {
    VersionInfo { id: HUB_ID.into(), version: APP_VERSION.into(), commit: BUILD_COMMIT.into() }
}

// ---- Managed mode ----------------------------------------------------------------------------

/// `%APPDATA%\com.socialmanager.desktop\hub-managed.json`, the same folder Tauri uses for app data.
pub fn marker_path(appdata: Option<&Path>) -> Option<PathBuf> {
    appdata.filter(|dir| !dir.as_os_str().is_empty()).map(|dir| dir.join(IDENTIFIER).join(MARKER_NAME))
}

/// Who manages updates ("Ava"), or None when the app updates itself. A marker that is not valid
/// JSON still counts: it was put there on purpose.
pub fn managed_by(args: &[String], marker: Option<&Path>) -> Option<String> {
    if let Some(path) = marker.filter(|path| path.is_file()) {
        let named = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).ok())
            .and_then(|value| value.get("managedBy")?.as_str().map(str::trim).filter(|name| !name.is_empty()).map(str::to_string));
        return Some(named.unwrap_or_else(|| DEFAULT_MANAGER.into()));
    }
    args.iter().any(|arg| arg == HUB_FLAG).then(|| DEFAULT_MANAGER.into())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManagement {
    /// "Ava" while the hub manages updates; null when the app updates itself.
    managed_by: Option<String>,
}

#[tauri::command]
pub fn update_management() -> UpdateManagement {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    UpdateManagement { managed_by: managed_by(&args, marker_path(appdata.as_deref()).as_deref()) }
}

// ---- Swapping the program --------------------------------------------------------------------

/// `social-manager.exe` → `social-manager.exe.old`: where the replaced program waits until it can be deleted.
pub fn aside_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(".old");
    target.with_file_name(name)
}

/// Deletes a program a previous swap set aside. It may still be running (then it stays until next time).
pub fn remove_aside(target: &Path) {
    let _ = fs::remove_file(aside_path(target));
}

/// Replaces `target` with a copy of `new_exe` and runs `verify` on it. On any failure the old
/// program is put back exactly as it was. `target` may be the running program.
pub fn swap_exe(target: &Path, new_exe: &Path, verify: &dyn Fn(&Path) -> Result<(), String>) -> Result<(), String> {
    if !new_exe.is_file() {
        return Err(format!("The new program {} is missing.", new_exe.display()));
    }
    let aside = aside_path(target);
    if aside.exists() {
        fs::remove_file(&aside).map_err(|error| format!("An older copy set aside earlier is still in use ({}): {error}", aside.display()))?;
    }
    fs::rename(target, &aside).map_err(|error| format!("Could not set the current program aside: {error}"))?;
    let restore = |why: String| {
        let _ = fs::remove_file(target);
        match fs::rename(&aside, target) {
            Ok(()) => why,
            Err(error) => format!("{why} Putting the old program back also failed ({error}); reinstall Social Space."),
        }
    };
    if let Err(error) = fs::copy(new_exe, target) {
        return Err(restore(format!("Could not copy the new program into place: {error}.")));
    }
    if let Err(error) = verify(target) {
        return Err(restore(format!("The new program did not check out: {error}")));
    }
    Ok(())
}

/// The version a swap replaced, kept for `--update rollback`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Previous {
    pub version: String,
    pub commit: String,
}

pub fn previous_exe(previous_dir: &Path) -> PathBuf {
    previous_dir.join(EXE_NAME)
}

pub fn read_previous(previous_dir: &Path) -> Option<Previous> {
    let previous: Previous = serde_json::from_slice(&fs::read(previous_dir.join(PREVIOUS_INFO)).ok()?).ok()?;
    previous_exe(previous_dir).is_file().then_some(previous)
}

/// Swaps `new_exe` in (verified) and keeps the program it replaced, described by `current`, as the
/// previous version. Rolling back passes the kept program itself as `new_exe`, so rolling back
/// twice goes forward again.
pub fn install_keeping_previous(
    target: &Path,
    new_exe: &Path,
    previous_dir: &Path,
    current: &Previous,
    verify: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    fs::create_dir_all(previous_dir).map_err(|error| format!("Could not create {}: {error}", previous_dir.display()))?;
    let staging = previous_dir.join(STAGING_EXE);
    fs::copy(target, &staging).map_err(|error| format!("Could not keep a copy of the current version: {error}"))?;
    if let Err(error) = swap_exe(target, new_exe, verify) {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }
    let kept = previous_exe(previous_dir);
    let _ = fs::remove_file(&kept);
    fs::rename(&staging, &kept).map_err(|error| format!("Updated, but keeping the previous version failed: {error}"))?;
    fs::write(previous_dir.join(PREVIOUS_INFO), serde_json::to_vec(current).unwrap_or_default())
        .map_err(|error| format!("Updated, but recording the previous version failed: {error}"))
}

/// Checks a `--version --json` answer against what should now be installed.
pub fn check_version_output(stdout: &str, expected_commit: &str) -> Result<VersionInfo, String> {
    let info = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<VersionInfo>(line.trim()).ok())
        .ok_or("it gave no version answer")?;
    if info.id != HUB_ID {
        return Err(format!("it says it is '{}', not {HUB_ID}", info.id));
    }
    if !expected_commit.eq_ignore_ascii_case(&info.commit) {
        return Err(format!("it reports build {}, expected {expected_commit}", info.commit));
    }
    Ok(info)
}

/// Starts `exe --version --json` with no window and checks it reports `expected_commit`.
pub fn verify_program(exe: &Path, expected_commit: &str) -> Result<VersionInfo, String> {
    let mut command = Command::new(exe);
    command.args(["--version", "--json"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::updater::hide_window(&mut command);
    let mut child = command.spawn().map_err(|error| format!("it would not start: {error}"))?;
    let began = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if began.elapsed() >= VERIFY_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("it did not answer --version in time".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(format!("could not wait for it: {error}")),
        }
    }
    let output = child.wait_with_output().map_err(|error| format!("could not read its answer: {error}"))?;
    check_version_output(&String::from_utf8_lossy(&output.stdout), expected_commit)
}

/// The "Apps & features" entries the installer writes (current name first, then the old one).
const UNINSTALL_KEYS: [&str; 2] = [
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Social Space",
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Social Manager",
];

/// Keeps "Apps & features" in step with a version swapped in without the installer. Best effort:
/// `--version --json` is the source of truth.
#[cfg(windows)]
pub fn record_installed_version(install_dir: &Path, version: &str) {
    for key in UNINSTALL_KEYS {
        let mut query = Command::new("reg");
        query.args(["query", key, "/v", "InstallLocation"]).stdin(Stdio::null());
        let Ok(output) = crate::updater::hide_window(&mut query).output() else { continue };
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(location) = text.lines().find_map(|line| line.split("REG_SZ").nth(1)).map(|value| value.trim().trim_matches('"').to_string()) else { continue };
        if !same_folder(&location, install_dir) {
            continue;
        }
        let mut add = Command::new("reg");
        add.args(["add", key, "/v", "DisplayVersion", "/t", "REG_SZ", "/d", version, "/f"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let _ = crate::updater::hide_window(&mut add).status();
    }
}

#[cfg(not(windows))]
pub fn record_installed_version(_install_dir: &Path, _version: &str) {}

fn same_folder(a: &str, b: &Path) -> bool {
    let norm = |text: &str| text.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    !a.trim().is_empty() && norm(a) == norm(&b.display().to_string())
}

/// An installed copy has the uninstaller next to it; a developer build in `target` does not, and
/// must never be swapped by a headless update.
pub fn is_installed_copy(exe: &Path) -> bool {
    exe.parent().is_some_and(|dir| dir.join("uninstall.exe").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn identity_matches_hub_app_json() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!("../../hub-app.json")).unwrap();
        assert_eq!(manifest["id"], HUB_ID);
        assert_eq!(manifest["version"], APP_VERSION);
        assert_eq!(manifest["identifier"], IDENTIFIER);
        let info = version_info();
        assert_eq!((info.id.as_str(), info.version.as_str()), (HUB_ID, APP_VERSION));
        assert!(!info.commit.is_empty());
        let line = serde_json::to_string(&info).unwrap();
        assert!(line.starts_with("{\"id\":\"social-space\",\"version\":"), "{line}");
    }

    #[test]
    fn the_marker_lives_in_the_app_data_folder() {
        let roaming = Path::new(r"C:\Users\me\AppData\Roaming");
        assert_eq!(marker_path(Some(roaming)), Some(roaming.join("com.socialmanager.desktop").join("hub-managed.json")));
        assert_eq!(marker_path(Some(Path::new(""))), None);
        assert_eq!(marker_path(None), None);
    }

    #[test]
    fn managed_mode_follows_the_marker_or_the_hub_flag() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join(MARKER_NAME);
        assert_eq!(managed_by(&args(&[]), Some(&marker)), None);
        assert_eq!(managed_by(&args(&["--hub"]), Some(&marker)).as_deref(), Some("Ava"));
        fs::write(&marker, br#"{"managedBy":"Ava","avaPath":"C:\\Ava\\ava.exe","since":1}"#).unwrap();
        assert_eq!(managed_by(&args(&[]), Some(&marker)).as_deref(), Some("Ava"));
        fs::write(&marker, b"{broken").unwrap();
        assert_eq!(managed_by(&args(&[]), Some(&marker)).as_deref(), Some("Ava"), "a damaged marker still counts");
        fs::remove_file(&marker).unwrap();
        assert_eq!(managed_by(&args(&[]), Some(&marker)), None, "removing the marker restores the app's updater");
    }

    fn program(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn a_verified_swap_replaces_the_program_and_sets_the_old_one_aside() {
        let dir = tempfile::tempdir().unwrap();
        let target = program(dir.path(), EXE_NAME, "old");
        let new = program(dir.path(), "new.exe", "new");
        swap_exe(&target, &new, &|_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(fs::read_to_string(aside_path(&target)).unwrap(), "old");
        remove_aside(&target);
        assert!(!aside_path(&target).exists());
    }

    #[test]
    fn a_failed_check_puts_the_old_program_back() {
        let dir = tempfile::tempdir().unwrap();
        let target = program(dir.path(), EXE_NAME, "old");
        let new = program(dir.path(), "new.exe", "broken");
        let error = swap_exe(&target, &new, &|_| Err("it reports build x".into())).unwrap_err();
        assert!(error.contains("did not check out") && error.contains("build x"), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "old");
        assert!(!aside_path(&target).exists());
        assert!(swap_exe(&target, &dir.path().join("missing.exe"), &|_| Ok(())).unwrap_err().contains("missing"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "old");
    }

    #[test]
    fn installing_keeps_the_previous_version_and_rolling_back_twice_goes_forward() {
        let dir = tempfile::tempdir().unwrap();
        let target = program(dir.path(), EXE_NAME, "v1");
        let built = program(dir.path(), "built.exe", "v2");
        let previous_dir = dir.path().join("previous");
        let v1 = Previous { version: "0.2.0".into(), commit: "a".repeat(40) };
        assert_eq!(read_previous(&previous_dir), None);
        install_keeping_previous(&target, &built, &previous_dir, &v1, &|_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "v2");
        assert_eq!(read_previous(&previous_dir), Some(v1.clone()));
        assert_eq!(fs::read_to_string(previous_exe(&previous_dir)).unwrap(), "v1");

        // Roll back: the kept program goes in, the one it replaced is kept instead.
        remove_aside(&target);
        let v2 = Previous { version: "0.2.1".into(), commit: "b".repeat(40) };
        install_keeping_previous(&target, &previous_exe(&previous_dir), &previous_dir, &v2, &|_| Ok(())).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "v1");
        assert_eq!(fs::read_to_string(previous_exe(&previous_dir)).unwrap(), "v2");
        assert_eq!(read_previous(&previous_dir), Some(v2));
    }

    #[test]
    fn a_failed_install_keeps_the_old_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let target = program(dir.path(), EXE_NAME, "v2");
        let previous_dir = dir.path().join("previous");
        fs::create_dir_all(&previous_dir).unwrap();
        program(&previous_dir, EXE_NAME, "v1");
        let v1 = Previous { version: "0.2.0".into(), commit: "a".repeat(40) };
        fs::write(previous_dir.join(PREVIOUS_INFO), serde_json::to_vec(&v1).unwrap()).unwrap();
        let built = program(dir.path(), "built.exe", "v3");
        let v2 = Previous { version: "0.2.1".into(), commit: "b".repeat(40) };
        assert!(install_keeping_previous(&target, &built, &previous_dir, &v2, &|_| Err("no".into())).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "v2");
        assert_eq!(read_previous(&previous_dir), Some(v1));
        assert!(!previous_dir.join(STAGING_EXE).exists());
    }

    #[test]
    fn the_version_answer_must_name_this_app_and_the_expected_build() {
        let good = format!("starting\n{{\"id\":\"social-space\",\"version\":\"0.2.1\",\"commit\":\"{}\"}}\n", "b".repeat(40));
        assert_eq!(check_version_output(&good, &"B".repeat(40)).unwrap().version, "0.2.1");
        assert!(check_version_output(&good, &"c".repeat(40)).unwrap_err().contains("expected"));
        let other = r#"{"id":"ai-studio","version":"1","commit":"x"}"#;
        assert!(check_version_output(other, "x").unwrap_err().contains("not social-space"));
        assert!(check_version_output("", "x").unwrap_err().contains("no version answer"));
    }

    #[test]
    fn only_an_installed_copy_is_swapped() {
        let dir = tempfile::tempdir().unwrap();
        let exe = program(dir.path(), EXE_NAME, "x");
        assert!(!is_installed_copy(&exe));
        program(dir.path(), "uninstall.exe", "u");
        assert!(is_installed_copy(&exe));
        assert!(same_folder(r#"C:\Users\me\AppData\Local\Social Space\"#, Path::new(r"c:\users\me\appdata\local\social space")) || !cfg!(windows));
    }
}
