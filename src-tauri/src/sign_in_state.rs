//! Whether each brand's window folder is signed in to each social, and as whom, so a brand card can
//! say "Signed in as @handle" or "Not signed in" before Nate presses Post.
//!
//! The check is read from an open brand window: its social sign-in cookie (only whether it is there,
//! never its value) and, where the page shows it, the signed-in username. It is kept on this PC in
//! `sign-in-state.json` next to the brand folders, and the app is told when it changes.

use std::{collections::BTreeMap, path::PathBuf, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::Platform;

const STATE_FILE: &str = "sign-in-state.json";
pub const EVENT: &str = "posting-sign-in";
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub signed_in: bool,
    /// The username the page showed as signed in, when it could be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    /// Unix milliseconds of the last check.
    pub checked_at: u64,
}

type Brands = BTreeMap<String, BTreeMap<String, SignIn>>;

const PLATFORMS: [Platform; 4] = [Platform::Tiktok, Platform::Youtube, Platform::X, Platform::Instagram];

fn key(platform: Platform) -> &'static str {
    match platform {
        Platform::Tiktok => "tiktok",
        Platform::Youtube => "youtube",
        Platform::X => "x",
        Platform::Instagram => "instagram",
    }
}

fn on(domain: &str, site: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == site || domain.ends_with(&format!(".{site}"))
}

/// Whether a social's own sign-in cookie is in the folder. `cookies` are (name, domain, has value).
fn signed_in_on(platform: Platform, cookies: &[(String, String, bool)]) -> bool {
    let wanted: &[(&str, &str)] = match platform {
        Platform::Tiktok => &[("sessionid", "tiktok.com")],
        Platform::X => &[("auth_token", "x.com"), ("auth_token", "twitter.com")],
        Platform::Youtube => &[("SID", "google.com"), ("LOGIN_INFO", "youtube.com")],
        Platform::Instagram => &[("sessionid", "instagram.com")],
    };
    cookies.iter().any(|(name, domain, has_value)| *has_value && wanted.iter().any(|(n, site)| name == n && on(domain, site)))
}

/// A username as the page shows it, or None when it isn't one.
fn clean_handle(raw: &str) -> Option<String> {
    let handle = raw.trim().trim_start_matches('/').trim_start_matches('@').trim();
    let valid = !handle.is_empty() && handle.len() <= 100 && handle.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    valid.then(|| handle.to_string())
}

/// Reads the signed-in username off the social's page, or "" when the page doesn't show it.
const HANDLE_SCRIPT: &str = r#"(() => { try {
  const host = location.hostname;
  const href = (selector) => { const a = document.querySelector(selector); return a ? (a.getAttribute('href') || '') : ''; };
  if (/(^|\.)tiktok\.com$/.test(host)) {
    const data = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (data) { try { const user = JSON.parse(data.textContent)['__DEFAULT_SCOPE__']['webapp.app-context'].user; if (user && user.uniqueId) return user.uniqueId; } catch (e) {} }
    return href('a[data-e2e="nav-profile"]').replace(/^\/@/, '').split(/[/?]/)[0];
  }
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return href('a[data-testid="AppTabBar_Profile_Link"]').replace(/^\//, '').split(/[/?]/)[0];
  return '';
} catch (e) { return ''; } })()"#;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join(STATE_FILE))
}

fn read(path: &PathBuf) -> Brands {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

/// The new state of every social for one brand. A handle read now wins; one read before is kept while
/// the same social stays signed in.
fn updated(previous: Option<&BTreeMap<String, SignIn>>, cookies: &[(String, String, bool)], platform: Platform, page_handle: Option<String>, now: u64) -> BTreeMap<String, SignIn> {
    PLATFORMS
        .iter()
        .map(|&each| {
            let signed_in = signed_in_on(each, cookies);
            let before = previous.and_then(|map| map.get(key(each)));
            let handle = if !signed_in {
                None
            } else if each == platform && page_handle.is_some() {
                page_handle.clone()
            } else {
                before.filter(|state| state.signed_in).and_then(|state| state.handle.clone())
            };
            (key(each).to_string(), SignIn { signed_in, handle, checked_at: now })
        })
        .collect()
}

/// Whether two states differ in anything but when they were checked.
fn changed(a: Option<&BTreeMap<String, SignIn>>, b: &BTreeMap<String, SignIn>) -> bool {
    let strip = |map: &BTreeMap<String, SignIn>| map.iter().map(|(k, v)| (k.clone(), v.signed_in, v.handle.clone())).collect::<Vec<_>>();
    a.map_or(true, |a| strip(a) != strip(b))
}

/// The username the window's page shows as signed in. Must run off the main thread.
fn page_handle(window: &WebviewWindow) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    window.eval_with_callback(HANDLE_SCRIPT, move |result| { let _ = tx.send(result); }).ok()?;
    let raw = rx.recv_timeout(Duration::from_secs(3)).ok()?;
    let text: String = serde_json::from_str(&raw).ok()?;
    clean_handle(&text)
}

/// Checks a brand window's sign-ins and saves them, telling the app when they changed. Must run off
/// the main thread (WebView2 cookies).
pub fn check(app: &AppHandle, window: &WebviewWindow, brand: &str, platform: Platform) {
    let Ok(cookies) = window.cookies() else { return };
    let cookies: Vec<(String, String, bool)> = cookies.iter().map(|c| (c.name().to_string(), c.domain().unwrap_or("").to_string(), !c.value().is_empty())).collect();
    let handle = page_handle(window);
    let Some(path) = state_path(app) else { return };
    let Ok(_guard) = FILE_LOCK.lock() else { return };
    let mut all = read(&path);
    let next = updated(all.get(brand), &cookies, platform, handle, now_ms());
    let notify = changed(all.get(brand), &next);
    all.insert(brand.to_string(), next);
    let Ok(bytes) = serde_json::to_vec_pretty(&all) else { return };
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path)).is_ok() && notify {
        let _ = app.emit(EVENT, brand.to_string());
    }
}

/// Every brand's last known sign-ins on this PC: brand id → social → state.
#[tauri::command]
pub fn posting_sign_ins(app: AppHandle) -> Result<Brands, String> {
    let path = state_path(&app).ok_or("Could not find the app's data folder.")?;
    let _guard = FILE_LOCK.lock().map_err(|_| "Could not read the sign-ins.")?;
    Ok(read(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jar(list: &[(&str, &str)]) -> Vec<(String, String, bool)> {
        list.iter().map(|(n, d)| (n.to_string(), d.to_string(), true)).collect()
    }

    #[test]
    fn reads_each_socials_own_sign_in_cookie() {
        let cookies = jar(&[("sessionid", ".tiktok.com"), ("ttwid", ".tiktok.com"), ("auth_token", ".x.com"), ("SID", ".google.com")]);
        assert!(signed_in_on(Platform::Tiktok, &cookies));
        assert!(signed_in_on(Platform::X, &cookies));
        assert!(signed_in_on(Platform::Youtube, &cookies));
        assert!(!signed_in_on(Platform::Instagram, &cookies));
        // A visitor's cookies are not a sign-in, nor is a look-alike site or an empty value.
        assert!(!signed_in_on(Platform::Tiktok, &jar(&[("ttwid", ".tiktok.com"), ("sessionid", ".nottiktok.com")])));
        assert!(!signed_in_on(Platform::Tiktok, &[("sessionid".into(), ".tiktok.com".into(), false)]));
    }

    #[test]
    fn keeps_a_handle_only_while_signed_in() {
        let signed = jar(&[("sessionid", ".tiktok.com")]);
        let first = updated(None, &signed, Platform::Tiktok, Some("animals".into()), 1);
        assert_eq!(first["tiktok"].handle.as_deref(), Some("animals"));
        assert!(!first["x"].signed_in);
        // Another window (X) doesn't read TikTok's name: the one read before stays.
        let again = updated(Some(&first), &signed, Platform::X, None, 2);
        assert_eq!(again["tiktok"].handle.as_deref(), Some("animals"));
        assert!(!changed(Some(&first), &again));
        let out = updated(Some(&again), &[], Platform::Tiktok, None, 3);
        assert!(!out["tiktok"].signed_in && out["tiktok"].handle.is_none());
        assert!(changed(Some(&again), &out));
    }

    #[test]
    fn handles_from_the_page_are_checked() {
        assert_eq!(clean_handle("@Animals.Daily").as_deref(), Some("Animals.Daily"));
        assert_eq!(clean_handle("/animals").as_deref(), Some("animals"));
        assert_eq!(clean_handle(""), None);
        assert_eq!(clean_handle("<script>"), None);
    }
}
