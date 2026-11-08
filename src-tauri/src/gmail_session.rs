//! Reads Gmail through the user's own Gmail sign-in inside the app.
//!
//! The user signs in to Gmail in an app window. The app then reads Gmail's
//! own unread-mail feed with that window's cookies, so no app password is
//! needed. The feed lists unread inbox mail (subject, sender, short preview),
//! which is where sign-up codes arrive. Nothing is marked as read.

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "email-source.json";
const FEED_URL: &str = "https://mail.google.com/mail/u/0/feed/atom";
const SIGN_UP_URL: &str = "https://accounts.google.com/signup";
const SIGN_IN_URL: &str = "https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/u/0/";
const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    gmail_session: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FeedEntry {
    pub uid: u32,
    pub subject: String,
    pub preview: String,
    pub from: String,
    pub date: String,
    pub link: String,
}

#[derive(Debug, PartialEq)]
pub struct Feed {
    pub address: Option<String>,
    pub entries: Vec<FeedEntry>,
}

/// Recently listed entries, so an email opened from the list can be shown again.
static CACHE: Mutex<Option<HashMap<u32, FeedEntry>>> = Mutex::new(None);

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|_| "Could not locate the app's data folder.".into())
}

fn read_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "Could not save email settings.")?;
    }
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| "Could not save email settings.")?;
    fs::write(path, bytes).map_err(|_| "Could not save email settings.".into())
}

/// The Gmail address in use when the inbox reads from the in-app Gmail sign-in.
pub fn active(app: &AppHandle) -> Option<String> {
    read_settings(app).gmail_session
}

pub fn forget(app: &AppHandle) -> Result<(), String> {
    let mut settings = read_settings(app);
    if settings.gmail_session.take().is_some() {
        write_settings(app, &settings)?;
    }
    Ok(())
}

fn uid_for(id: &str) -> u32 {
    // FNV-1a, kept below 2^31 so it is a safe number in JavaScript.
    let mut hash: u32 = 0x811c_9dc5;
    for byte in id.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash & 0x7fff_ffff
}

fn child_text(node: roxmltree::Node, name: &str) -> String {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
        .and_then(|child| child.text())
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// Parses Gmail's Atom 0.3 feed.
pub fn parse_feed(xml: &str) -> Result<Feed, String> {
    let document = roxmltree::Document::parse(xml).map_err(|_| "Gmail sent an unreadable inbox feed.")?;
    let root = document.root_element();
    if root.tag_name().name() != "feed" {
        return Err("Gmail sent an unreadable inbox feed.".into());
    }
    let title = child_text(root, "title");
    let address = title
        .rsplit(' ')
        .next()
        .filter(|word| word.contains('@'))
        .map(str::to_owned);
    let entries = root
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "entry")
        .map(|entry| {
            let author = entry
                .children()
                .find(|child| child.is_element() && child.tag_name().name() == "author");
            let (name, email) = author
                .map(|author| (child_text(author, "name"), child_text(author, "email")))
                .unwrap_or_default();
            let from = match (name.is_empty(), email.is_empty()) {
                (false, false) => format!("{name} <{email}>"),
                (false, true) => name,
                _ => email,
            };
            let link = entry
                .children()
                .find(|child| child.is_element() && child.tag_name().name() == "link")
                .and_then(|link| link.attribute("href"))
                .unwrap_or_default()
                .to_owned();
            let id = child_text(entry, "id");
            let issued = child_text(entry, "issued");
            FeedEntry {
                uid: uid_for(if id.is_empty() { &link } else { &id }),
                subject: child_text(entry, "title"),
                preview: child_text(entry, "summary"),
                from,
                date: if issued.is_empty() { child_text(entry, "modified") } else { issued },
                link,
            }
        })
        .collect();
    Ok(Feed { address, entries })
}

fn any_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or_else(|| "The app window is not ready yet.".into())
}

async fn fetch(app: &AppHandle) -> Result<Feed, String> {
    let feed_url: url::Url = FEED_URL.parse().expect("valid feed URL");
    let cookies = any_window(app)?
        .cookies_for_url(feed_url.clone())
        .map_err(|_| "Could not read the Gmail sign-in from the app.")?;
    if cookies.is_empty() {
        return Err("Not signed in to Gmail yet. Press Sign in to Gmail.".into());
    }
    let header = cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not prepare the Gmail connection.")?;
    let response = client
        .get(feed_url)
        .header(reqwest::header::COOKIE, header)
        .send()
        .await
        .map_err(|_| "Could not reach Gmail. Check your internet connection.")?;
    let status = response.status();
    if status.is_redirection() || status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Your Gmail sign-in has expired. Press Sign in to Gmail again.".into());
    }
    if !status.is_success() {
        return Err(format!("Gmail returned an error ({status})."));
    }
    let body = response.text().await.map_err(|_| "Gmail sent an unreadable inbox feed.")?;
    let feed = parse_feed(&body)?;
    if let Ok(mut cache) = CACHE.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        for entry in &feed.entries {
            map.insert(entry.uid, entry.clone());
        }
    }
    Ok(feed)
}

pub async fn list(app: &AppHandle, limit: usize, search: Option<&str>) -> Result<Vec<FeedEntry>, String> {
    let feed = fetch(app).await?;
    let term = search.map(|term| term.trim().to_lowercase()).filter(|term| !term.is_empty());
    Ok(feed
        .entries
        .into_iter()
        .filter(|entry| {
            term.as_ref().is_none_or(|term| {
                format!("{} {} {}", entry.subject, entry.preview, entry.from)
                    .to_lowercase()
                    .contains(term)
            })
        })
        .take(limit)
        .collect())
}

pub fn cached(uid: u32) -> Option<FeedEntry> {
    CACHE.lock().ok()?.as_ref()?.get(&uid).cloned()
}

/// Opens Google's own sign-up page in an app window so a brand can get a new Gmail.
/// Returns the window id so the form can be pre-filled; the user presses every button.
#[tauri::command]
pub fn open_gmail_signup(app: AppHandle) -> Result<String, String> {
    crate::browser::open_remote_window(&app, SIGN_UP_URL, false)
}

#[tauri::command]
pub fn open_gmail_sign_in(app: AppHandle) -> Result<(), String> {
    crate::browser::open_remote(&app, SIGN_IN_URL, false)
}

/// Opens one email from the list in Gmail inside the app, to read all of it.
#[tauri::command]
pub fn open_gmail_message(app: AppHandle, uid: u32) -> Result<(), String> {
    let entry = cached(uid).ok_or("Refresh the inbox, then try again.")?;
    let link: url::Url = entry.link.parse().map_err(|_| "Gmail did not give a link for this email.")?;
    if link.scheme() != "https" || link.host_str() != Some("mail.google.com") {
        return Err("Gmail did not give a usable link for this email.".into());
    }
    crate::browser::open_remote(&app, link.as_str(), false)
}

/// Checks the in-app Gmail sign-in works and switches the inbox to it.
#[tauri::command]
pub async fn connect_gmail_session(app: AppHandle) -> Result<crate::email::EmailConnection, String> {
    let feed = fetch(&app).await?;
    let address = feed.address.unwrap_or_else(|| "Gmail".into());
    write_settings(&app, &Settings { gmail_session: Some(address.clone()) })?;
    Ok(crate::email::EmailConnection::gmail(address))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#">
<title>Gmail - Inbox for softwings25@gmail.com</title>
<fullcount>2</fullcount>
<entry>
<title>482913 is your Instagram code</title>
<summary>Hi softwings, confirm your email address. Your code is 482913.</summary>
<link rel="alternate" href="https://mail.google.com/mail?account_id=softwings25@gmail.com&amp;message_id=18f&amp;view=conv" type="text/html" />
<modified>2026-11-08T14:40:00Z</modified>
<issued>2026-11-08T14:40:00Z</issued>
<id>tag:gmail.google.com,2004:1798765432109876543</id>
<author><name>Instagram</name><email>security@mail.instagram.com</email></author>
</entry>
<entry>
<title>Welcome to TikTok</title>
<summary>Thanks for joining</summary>
<id>tag:gmail.google.com,2004:1798765432109876544</id>
<author><email>noreply@tiktok.com</email></author>
</entry>
</feed>"#;

    #[test]
    fn parses_gmail_feed_entries_and_address() {
        let feed = parse_feed(SAMPLE).unwrap();
        assert_eq!(feed.address.as_deref(), Some("softwings25@gmail.com"));
        assert_eq!(feed.entries.len(), 2);
        let first = &feed.entries[0];
        assert_eq!(first.subject, "482913 is your Instagram code");
        assert_eq!(first.from, "Instagram <security@mail.instagram.com>");
        assert!(first.preview.contains("482913"));
        assert!(first.link.contains("message_id=18f"));
        assert_eq!(feed.entries[1].from, "noreply@tiktok.com");
        assert_ne!(first.uid, feed.entries[1].uid);
        assert!(first.uid < 0x8000_0000);
    }

    #[test]
    fn rejects_non_feed_pages() {
        assert!(parse_feed("<html><body>Sign in</body></html>").is_err());
        assert!(parse_feed("not xml").is_err());
    }
}
