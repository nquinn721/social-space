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

fn key(platform: Platform) -> &'static str {
    match platform {
        Platform::Tiktok => "tiktok",
        Platform::Youtube => "youtube",
        Platform::X => "x",
        Platform::Instagram => "instagram",
        Platform::Facebook => "facebook",
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
        Platform::Facebook => &[("c_user", "facebook.com")],
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
    const nav = href('a[data-e2e="nav-profile"]').replace(/^\/@/, '').split(/[/?]/)[0];
    if (nav) return nav;
    // A public profile URL alone identifies the profile being viewed, not the signed-in user.
    // Only use it when TikTok also shows the owner-only Edit profile control.
    const ownProfile = [...document.querySelectorAll('button, a[role="button"]')]
      .some((button) => button.textContent.trim().toLowerCase() === 'edit profile');
    const match = location.pathname.match(/^\/@([a-zA-Z0-9._-]+)\/?$/);
    return ownProfile && match ? match[1] : '';
  }
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

/// Update only the social being viewed. Another social's stale cookie must not undo a sign-out
/// observed on its login page. Only a handle seen on this check is retained for the current social.
fn updated(previous: Option<&BTreeMap<String, SignIn>>, cookies: &[(String, String, bool)], platform: Platform, page_handle: Option<String>, login_page: bool, now: u64) -> BTreeMap<String, SignIn> {
    let mut next = previous.cloned().unwrap_or_default();
    let signed_in = signed_in_on(platform, cookies) && !login_page;
    let handle = if signed_in { page_handle } else { None };
    next.insert(key(platform).to_string(), SignIn { signed_in, handle, checked_at: now });
    next
}

/// Whether two states differ in anything but when they were checked.
fn changed(a: Option<&BTreeMap<String, SignIn>>, b: &BTreeMap<String, SignIn>) -> bool {
    let strip = |map: &BTreeMap<String, SignIn>| map.iter().map(|(k, v)| (k.clone(), v.signed_in, v.handle.clone())).collect::<Vec<_>>();
    a.map_or(true, |a| strip(a) != strip(b))
}

/// The username the window's page shows as signed in. Must run off the main thread.
fn may_read_page_handle(url: &url::Url) -> bool {
    !crate::browser::is_x_site(url)
}

/// An explicit login page is stronger evidence than an old, still-present session cookie.
fn is_login_page(platform: Platform, url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("").trim_start_matches("www.");
    let path = url.path();
    match platform {
        Platform::Tiktok => on(host, "tiktok.com") && path.starts_with("/login"),
        Platform::X => (on(host, "x.com") || on(host, "twitter.com")) && (path == "/login" || path.starts_with("/i/flow/login")),
        Platform::Youtube => host == "accounts.google.com" && (path.starts_with("/signin") || path.starts_with("/v3/signin")),
        Platform::Instagram => on(host, "instagram.com") && path.starts_with("/accounts/login"),
        Platform::Facebook => on(host, "facebook.com") && path.starts_with("/login"),
    }
}

fn page_handle(window: &WebviewWindow) -> Option<String> {
    let url = window.url().ok()?;
    if !may_read_page_handle(&url) { return None; }
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
    let login_page = window.url().ok().is_some_and(|url| is_login_page(platform, &url));
    let Some(path) = state_path(app) else { return };
    let Ok(_guard) = FILE_LOCK.lock() else { return };
    let mut all = read(&path);
    let next = updated(all.get(brand), &cookies, platform, handle, login_page, now_ms());
    let notify = changed(all.get(brand), &next);
    all.insert(brand.to_string(), next);
    let Ok(bytes) = serde_json::to_vec_pretty(&all) else { return };
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path)).is_ok() && notify {
        let _ = app.emit(EVENT, brand.to_string());
    }
}

/// Whether a brand's window folder was last seen signed in to a social (false when never checked).
pub fn known_signed_in(app: &AppHandle, brand: &str, platform: Platform) -> bool {
    let Some(path) = state_path(app) else { return false };
    let Ok(_guard) = FILE_LOCK.lock() else { return false };
    read(&path).get(brand).and_then(|map| map.get(key(platform))).map_or(false, |state| state.signed_in)
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
        let first = updated(None, &signed, Platform::Tiktok, Some("animals".into()), false, 1);
        assert_eq!(first["tiktok"].handle.as_deref(), Some("animals"));
        assert!(!first.contains_key("x"));
        // Another window (X) doesn't read TikTok's name: the one read before stays.
        let again = updated(Some(&first), &signed, Platform::X, None, false, 2);
        assert_eq!(again["tiktok"].handle.as_deref(), Some("animals"));
        assert!(!again["x"].signed_in);
        let unknown = updated(Some(&again), &signed, Platform::Tiktok, None, false, 3);
        assert_eq!(unknown["tiktok"].handle, None);
        assert!(changed(Some(&again), &unknown));
        let out = updated(Some(&again), &[], Platform::Tiktok, None, false, 3);
        assert!(!out["tiktok"].signed_in && out["tiktok"].handle.is_none());
        assert!(changed(Some(&again), &out));
    }

    #[test]
    fn login_page_marks_only_that_social_signed_out_even_with_a_stale_cookie() {
        let cookies = jar(&[("sessionid", ".tiktok.com"), ("SID", ".google.com")]);
        let prior = updated(None, &cookies, Platform::Youtube, None, false, 0);
        let state = updated(Some(&prior), &cookies, Platform::Tiktok, None, true, 1);
        assert!(!state["tiktok"].signed_in);
        assert!(state["youtube"].signed_in);
        let other_check = updated(Some(&state), &cookies, Platform::Youtube, None, false, 2);
        assert!(!other_check["tiktok"].signed_in);
        assert!(is_login_page(Platform::Tiktok, &"https://www.tiktok.com/login/phone-or-email/email".parse().unwrap()));
        assert!(is_login_page(Platform::Youtube, &"https://accounts.google.com/v3/signin/identifier".parse().unwrap()));
        assert!(!is_login_page(Platform::Youtube, &"https://accounts.google.com/o/oauth2/auth".parse().unwrap()));
        assert!(!is_login_page(Platform::Tiktok, &"https://example.com/login".parse().unwrap()));
    }

    #[test]
    fn handles_from_the_page_are_checked() {
        assert_eq!(clean_handle("@Animals.Daily").as_deref(), Some("Animals.Daily"));
        assert_eq!(clean_handle("/animals").as_deref(), Some("animals"));
        assert_eq!(clean_handle(""), None);
        assert_eq!(clean_handle("<script>"), None);
    }

    #[test]
    fn never_inspects_an_x_page_for_a_handle() {
        for address in ["https://x.com/home", "https://mobile.twitter.com/home"] {
            assert!(!may_read_page_handle(&address.parse().unwrap()));
        }
        assert!(may_read_page_handle(&"https://www.tiktok.com/".parse().unwrap()));
    }
}
