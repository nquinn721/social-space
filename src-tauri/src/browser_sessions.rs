//! Shares each brand's social sign-ins (the cookies of its posting window) between the two PCs of a
//! team, so a brand signed in on one PC is signed in on the other too.
//!
//! The cookies of a brand's browser folder are kept in `browser-sessions.json` in the app data folder,
//! which team sync encrypts and shares like the other shared files (merged brand by brand). Only the
//! socials' own cookies are kept. When a brand window opens and the other PC saved a newer session,
//! those cookies are put into this PC's folder before the page loads. Nothing about the device is
//! changed or hidden: a social may still ask to sign in again, and then the window says so and its
//! sign-in form is filled from the saved login as usual.

use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{webview::cookie::{time::OffsetDateTime, Cookie, Expiration, SameSite}, AppHandle, Manager, WebviewWindow};

pub const SESSIONS_FILE: &str = "browser-sessions.json";
/// When this PC last took in or saved each brand's shared session. Stays on this PC.
const LOCAL_FILE: &str = "browser-sessions-seen.json";
/// Cookies of these sites (and their subdomains) are shared; everything else stays on this PC.
const SOCIAL_DOMAINS: &[&str] = &["tiktok.com", "youtube.com", "google.com", "x.com", "twitter.com", "instagram.com", "facebook.com"];
const MAX_COOKIES: usize = 400;

static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    /// Unix seconds; None for a cookie that lasts while the browser is open.
    #[serde(default)]
    expires: Option<i64>,
    #[serde(default)]
    secure: bool,
    #[serde(default)]
    http_only: bool,
    /// "strict", "lax" or "none".
    #[serde(default)]
    same_site: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandSession {
    saved_at: u64,
    saved_by: String,
    cookies: Vec<StoredCookie>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn machine() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this PC".into())
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

fn read_map<T: for<'de> Deserialize<'de>>(path: &Path) -> BTreeMap<String, T> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn write_map<T: Serialize>(path: &Path, map: &BTreeMap<String, T>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?)
        .and_then(|_| std::fs::rename(&temporary, path))
        .map_err(|e| format!("Could not save the shared sign-ins: {e}"))
}

pub(crate) fn is_social_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    SOCIAL_DOMAINS.iter().any(|site| domain == *site || domain.ends_with(&format!(".{site}")))
}

fn stored(cookie: &Cookie<'static>) -> Option<StoredCookie> {
    let domain = cookie.domain()?.to_string();
    if !is_social_domain(&domain) {
        return None;
    }
    let expires = match cookie.expires() {
        Some(Expiration::DateTime(at)) => Some(at.unix_timestamp()),
        _ => None,
    };
    Some(StoredCookie {
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        domain,
        path: cookie.path().unwrap_or("/").to_string(),
        expires,
        secure: cookie.secure().unwrap_or(false),
        http_only: cookie.http_only().unwrap_or(false),
        same_site: cookie.same_site().map(|s| s.to_string().to_ascii_lowercase()),
    })
}

fn live(cookie: &StoredCookie) -> Cookie<'static> {
    let mut built = Cookie::build((cookie.name.clone(), cookie.value.clone()))
        .domain(cookie.domain.clone())
        .path(cookie.path.clone())
        .secure(cookie.secure)
        .http_only(cookie.http_only);
    if let Some(at) = cookie.expires.and_then(|secs| OffsetDateTime::from_unix_timestamp(secs).ok()) {
        built = built.expires(at);
    }
    built = match cookie.same_site.as_deref() {
        Some("strict") => built.same_site(SameSite::Strict),
        Some("lax") => built.same_site(SameSite::Lax),
        Some("none") => built.same_site(SameSite::None),
        _ => built,
    };
    built.build()
}

/// The social cookies worth sharing, sorted so two reads of the same session compare equal.
fn shareable(cookies: &[Cookie<'static>], now_secs: i64) -> Vec<StoredCookie> {
    let mut list: Vec<StoredCookie> = cookies.iter().filter_map(stored).filter(|c| c.expires.is_none_or(|at| at > now_secs)).collect();
    list.sort();
    list.dedup();
    list.truncate(MAX_COOKIES);
    list
}

/// The other PC's session for this brand, when it is newer than what this PC already has.
fn newer_session(sessions: &BTreeMap<String, BrandSession>, seen: &BTreeMap<String, u64>, brand: &str, me: &str) -> Option<BrandSession> {
    let session = sessions.get(brand)?;
    (session.saved_by != me && session.saved_at > seen.get(brand).copied().unwrap_or(0) && !session.cookies.is_empty()).then(|| session.clone())
}

/// Before a brand window loads its page: puts the other PC's newer session into this PC's folder.
/// Returns true when a shared session was put in. Must run off the main thread (WebView2 cookies).
pub fn restore(app: &AppHandle, window: &WebviewWindow, brand: &str) -> bool {
    let Some(dir) = data_dir(app) else { return false };
    let session = {
        let Ok(_guard) = FILE_LOCK.lock() else { return false };
        let sessions: BTreeMap<String, BrandSession> = read_map(&dir.join(SESSIONS_FILE));
        let seen: BTreeMap<String, u64> = read_map(&dir.join(LOCAL_FILE));
        newer_session(&sessions, &seen, brand, &machine())
    };
    let Some(session) = session else { return false };
    let mut put = 0;
    for cookie in &session.cookies {
        if window.set_cookie(live(cookie)).is_ok() {
            put += 1;
        }
    }
    if let Ok(_guard) = FILE_LOCK.lock() {
        let path = dir.join(LOCAL_FILE);
        let mut seen: BTreeMap<String, u64> = read_map(&path);
        seen.insert(brand.to_string(), session.saved_at);
        let _ = write_map(&path, &seen);
    }
    put > 0
}

/// Saves the brand window's social cookies for the other PC, when they changed. Must run off the main
/// thread (WebView2 cookies).
pub fn capture(app: &AppHandle, window: &WebviewWindow, brand: &str) {
    let Some(dir) = data_dir(app) else { return };
    let Ok(cookies) = window.cookies() else { return };
    let now = now_ms();
    let list = shareable(&cookies, (now / 1000) as i64);
    if list.is_empty() {
        return;
    }
    let Ok(_guard) = FILE_LOCK.lock() else { return };
    let path = dir.join(SESSIONS_FILE);
    let mut sessions: BTreeMap<String, BrandSession> = read_map(&path);
    if sessions.get(brand).is_some_and(|session| session.cookies == list) {
        return;
    }
    sessions.insert(brand.to_string(), BrandSession { saved_at: now, saved_by: machine(), cookies: list });
    if write_map(&path, &sessions).is_ok() {
        let seen_path = dir.join(LOCAL_FILE);
        let mut seen: BTreeMap<String, u64> = read_map(&seen_path);
        seen.insert(brand.to_string(), now);
        let _ = write_map(&seen_path, &seen);
    }
}

/// Shown in a brand window when the social asked to sign in although the other PC's session was put
/// in: the shared sign-in was not accepted here, and the saved login is filled in instead.
pub const REJECTED_NOTICE: &str = r#"(() => {
  if (document.getElementById('socialspace-session-note')) return;
  const note = document.createElement('div');
  note.id = 'socialspace-session-note';
  note.textContent = "The sign-in shared from your partner's PC wasn't accepted here, so sign in once on this PC. Your saved login is filled in.";
  note.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#3b2a12;color:#ffe2b0;border:1px solid #a8742a;padding:10px 14px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;max-width:560px;box-shadow:0 6px 24px rgba(0,0,0,.35)';
  document.documentElement.appendChild(note);
  setTimeout(() => note.remove(), 20000);
})();"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, domain: &str, expires: Option<i64>) -> Cookie<'static> {
        let mut built = Cookie::build((name.to_string(), "v".to_string())).domain(domain.to_string()).path("/").secure(true).http_only(true).same_site(SameSite::Lax);
        if let Some(at) = expires {
            built = built.expires(OffsetDateTime::from_unix_timestamp(at).unwrap());
        }
        built.build()
    }

    #[test]
    fn keeps_only_live_social_cookies() {
        let cookies = vec![cookie("sid", ".tiktok.com", Some(2_000)), cookie("ads", ".doubleclick.net", None), cookie("old", ".x.com", Some(10)), cookie("SID", "accounts.google.com", None)];
        let list = shareable(&cookies, 1_000);
        let names: Vec<_> = list.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["SID", "sid"]);
        assert!(!is_social_domain("nottiktok.com"));
        assert!(is_social_domain("studio.youtube.com"));
    }

    #[test]
    fn a_stored_cookie_comes_back_the_same() {
        let original = cookie("sessionid", ".tiktok.com", Some(1_900_000_000));
        let again = stored(&live(&stored(&original).unwrap())).unwrap();
        assert_eq!(again, stored(&original).unwrap());
        assert_eq!(again.same_site.as_deref(), Some("lax"));
    }

    #[test]
    fn takes_only_the_other_pcs_newer_session() {
        let session = |by: &str, at: u64| BrandSession { saved_at: at, saved_by: by.into(), cookies: vec![stored(&cookie("sid", ".x.com", None)).unwrap()] };
        let sessions: BTreeMap<_, _> = [("b1".to_string(), session("PARTNER", 50))].into();
        assert!(newer_session(&sessions, &BTreeMap::new(), "b1", "NATE").is_some());
        assert!(newer_session(&sessions, &[("b1".to_string(), 50)].into(), "b1", "NATE").is_none(), "already taken in");
        assert!(newer_session(&sessions, &BTreeMap::new(), "b1", "PARTNER").is_none(), "this PC's own session");
        assert!(newer_session(&sessions, &BTreeMap::new(), "b2", "NATE").is_none());
    }
}
