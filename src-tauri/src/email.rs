//! Read-only access to the user's own mailbox over IMAP (implicit TLS).
//! The mailbox is opened with EXAMINE, so reading never marks mail as read
//! or changes it. Credentials live in Windows Credential Manager.

use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};

const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LIST: usize = 50;
const MAX_BODY_CHARS: usize = 20_000;
#[cfg(windows)]
const KEYRING_SERVICE: &str = "social-manager-email";
#[cfg(windows)]
const KEYRING_ENTRY: &str = "primary";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    host: String,
    port: u16,
    username: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailConnection {
    host: String,
    username: String,
    /// "imap" for an app-password mailbox, "gmail" for the in-app Gmail sign-in.
    kind: &'static str,
}

impl EmailConnection {
    pub fn gmail(address: String) -> Self {
        Self { host: "Gmail sign-in in the app".into(), username: address, kind: "gmail" }
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmailSummary {
    uid: u32,
    from: String,
    subject: String,
    date: String,
    unread: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmailMessage {
    uid: u32,
    from: String,
    to: String,
    subject: String,
    date: String,
    body: String,
}

#[cfg(windows)]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ENTRY)
        .map_err(|_| "Windows Credential Manager is unavailable.".into())
}

#[cfg(windows)]
fn load() -> Result<Option<Credential>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "Saved email settings are damaged. Reconnect your email.".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read email settings from Windows Credential Manager.".into()),
    }
}

#[cfg(windows)]
fn store(credential: &Credential) -> Result<(), String> {
    let value = serde_json::to_string(credential).map_err(|_| "Could not save email settings.")?;
    entry()?
        .set_password(&value)
        .map_err(|_| "Could not save email settings to Windows Credential Manager.".into())
}

#[cfg(not(windows))]
fn load() -> Result<Option<Credential>, String> {
    Err("Email is currently supported on Windows only.".into())
}

#[cfg(not(windows))]
fn store(_: &Credential) -> Result<(), String> {
    Err("Email is currently supported on Windows only.".into())
}

fn required() -> Result<Credential, String> {
    load()?.ok_or_else(|| "Connect your email in Settings first.".into())
}

fn validate(credential: &Credential) -> Result<(), String> {
    let host = credential.host.as_str();
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    if !host_ok || credential.port == 0 {
        return Err("Enter your mail server, like imap.gmail.com.".into());
    }
    if credential.username.trim().is_empty()
        || credential.password.is_empty()
        || credential.username.len() > 320
        || credential.password.len() > 1_000
        || credential.username.chars().any(char::is_control)
        || credential.password.chars().any(char::is_control)
    {
        return Err("Enter your email address and app password.".into());
    }
    Ok(())
}

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

fn open(credential: &Credential) -> Result<imap::Session<Box<dyn Stream + Send>>, String> {
    let offline = "Could not reach your mail server.";
    let address = (credential.host.as_str(), credential.port)
        .to_socket_addrs()
        .map_err(|_| offline)?
        .next()
        .ok_or(offline)?;
    let tcp = TcpStream::connect_timeout(&address, IO_TIMEOUT).map_err(|_| offline)?;
    tcp.set_read_timeout(Some(IO_TIMEOUT)).map_err(|_| offline)?;
    tcp.set_write_timeout(Some(IO_TIMEOUT)).map_err(|_| offline)?;
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| "Could not prepare a secure connection.")?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(credential.host.clone())
        .map_err(|_| "Invalid mail server name.")?;
    let connection = rustls::ClientConnection::new(Arc::new(config), name)
        .map_err(|_| "Could not start a secure connection.")?;
    let stream: Box<dyn Stream + Send> = Box::new(rustls::StreamOwned::new(connection, tcp));
    let mut client = imap::Client::new(stream);
    client
        .read_greeting()
        .map_err(|_| "The mail server did not answer securely.")?;
    client
        .login(&credential.username, &credential.password)
        .map_err(|_| {
            "Sign-in failed. Check the address and use an app password (Gmail and Outlook require one).".into()
        })
}

fn decode_header(headers: &[mailparse::MailHeader], name: &str) -> String {
    use mailparse::MailHeaderMap;
    headers.get_first_value(name).unwrap_or_default()
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(limit).collect();
    cut.push('…');
    cut
}

fn strip_html(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::new();
    let mut blank_lines = 0;
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank_lines += 1;
            if blank_lines > 1 {
                continue;
            }
        } else {
            blank_lines = 0;
        }
        out.push_str(&line);
        out.push('\n');
    }
    out.trim().to_owned()
}

fn find_part(part: &mailparse::ParsedMail, mime: &str) -> Option<String> {
    if part.subparts.is_empty() {
        let disposition = part.get_content_disposition().disposition;
        if part.ctype.mimetype.eq_ignore_ascii_case(mime)
            && disposition != mailparse::DispositionType::Attachment
        {
            return part.get_body().ok();
        }
        return None;
    }
    part.subparts.iter().find_map(|sub| find_part(sub, mime))
}

fn body_text(mail: &mailparse::ParsedMail) -> String {
    let text = find_part(mail, "text/plain")
        .or_else(|| find_part(mail, "text/html").map(|html| strip_html(&html)))
        .unwrap_or_default();
    truncate(&collapse_whitespace(&text), MAX_BODY_CHARS)
}

/// IMAP quoted strings cannot safely carry quotes, backslashes or line breaks.
fn search_query(search: Option<&str>, unread_only: bool) -> Result<String, String> {
    let mut query = if unread_only { "UNSEEN".to_owned() } else { "ALL".to_owned() };
    if let Some(term) = search.map(str::trim).filter(|term| !term.is_empty()) {
        if term.len() > 200 || term.chars().any(|c| c == '"' || c == '\\' || c.is_control()) {
            return Err("Search for plain words without quotes.".into());
        }
        query.push_str(&format!(" TEXT \"{term}\""));
    }
    Ok(query)
}

fn summary(fetch: &imap::types::Fetch) -> Option<EmailSummary> {
    let (headers, _) = mailparse::parse_headers(fetch.header()?).ok()?;
    Some(EmailSummary {
        uid: fetch.uid?,
        from: decode_header(&headers, "From"),
        subject: decode_header(&headers, "Subject"),
        date: decode_header(&headers, "Date"),
        unread: !fetch.flags().contains(&imap::types::Flag::Seen),
    })
}

#[tauri::command]
pub fn email_connection(app: tauri::AppHandle) -> Result<Option<EmailConnection>, String> {
    if let Some(address) = crate::gmail_session::active(&app) {
        return Ok(Some(EmailConnection::gmail(address)));
    }
    Ok(load()?.map(|credential| EmailConnection {
        host: credential.host,
        username: credential.username,
        kind: "imap",
    }))
}

#[tauri::command]
pub async fn connect_email(
    app: tauri::AppHandle,
    host: String,
    port: Option<u16>,
    username: String,
    password: String,
) -> Result<EmailConnection, String> {
    let credential = Credential {
        host: host.trim().to_ascii_lowercase(),
        port: port.unwrap_or(993),
        username: username.trim().to_owned(),
        password,
    };
    validate(&credential)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = open(&credential)?;
        let _ = session.logout();
        store(&credential)?;
        crate::gmail_session::forget(&app)?;
        Ok(EmailConnection {
            host: credential.host,
            username: credential.username,
            kind: "imap",
        })
    })
    .await
    .map_err(|_| "Email connection stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub fn disconnect_email(app: tauri::AppHandle) -> Result<(), String> {
    if crate::gmail_session::active(&app).is_some() {
        return crate::gmail_session::forget(&app);
    }
    #[cfg(windows)]
    return match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove email settings from Windows Credential Manager.".into()),
    };
    #[cfg(not(windows))]
    Err("Email is currently supported on Windows only.".into())
}

#[tauri::command]
pub async fn list_emails(
    app: tauri::AppHandle,
    limit: Option<usize>,
    unread_only: Option<bool>,
    search: Option<String>,
) -> Result<Vec<EmailSummary>, String> {
    let limit = limit.unwrap_or(10).clamp(1, MAX_LIST);
    if crate::gmail_session::active(&app).is_some() {
        // Gmail's feed only holds unread mail, so every item is unread.
        let entries = crate::gmail_session::list(&app, limit, search.as_deref()).await?;
        return Ok(entries
            .into_iter()
            .map(|entry| EmailSummary { uid: entry.uid, from: entry.from, subject: entry.subject, date: entry.date, unread: true })
            .collect());
    }
    let credential = required()?;
    let query = search_query(search.as_deref(), unread_only.unwrap_or(false))?;
    tauri::async_runtime::spawn_blocking(move || {
        let failed = "Could not read your inbox.";
        let mut session = open(&credential)?;
        session.examine("INBOX").map_err(|_| failed)?;
        let mut uids: Vec<u32> = session.uid_search(&query).map_err(|_| failed)?.into_iter().collect();
        uids.sort_unstable_by(|a, b| b.cmp(a));
        uids.truncate(limit);
        if uids.is_empty() {
            let _ = session.logout();
            return Ok(Vec::new());
        }
        let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetches = session
            .uid_fetch(&set, "(UID FLAGS RFC822.HEADER)")
            .map_err(|_| failed)?;
        let mut list: Vec<EmailSummary> = fetches.iter().filter_map(summary).collect();
        list.sort_unstable_by(|a, b| b.uid.cmp(&a.uid));
        let _ = session.logout();
        Ok(list)
    })
    .await
    .map_err(|_| "Reading email stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn read_email(app: tauri::AppHandle, uid: u32) -> Result<EmailMessage, String> {
    if let Some(address) = crate::gmail_session::active(&app) {
        let entry = crate::gmail_session::cached(uid).ok_or("Refresh the inbox, then open the email again.")?;
        let body = if entry.link.is_empty() {
            entry.preview
        } else {
            format!("{}\n\n(Gmail only shares a preview here. Open Gmail in the app to read the whole email.)", entry.preview)
        };
        return Ok(EmailMessage { uid, from: entry.from, to: address, subject: entry.subject, date: entry.date, body });
    }
    let credential = required()?;
    tauri::async_runtime::spawn_blocking(move || {
        let failed = "Could not open that email.";
        let mut session = open(&credential)?;
        session.examine("INBOX").map_err(|_| failed)?;
        let fetches = session
            .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
            .map_err(|_| failed)?;
        let fetch = fetches.iter().next().ok_or("That email was not found.")?;
        let raw = fetch.body().ok_or(failed)?;
        let mail = mailparse::parse_mail(raw).map_err(|_| failed)?;
        let message = EmailMessage {
            uid,
            from: decode_header(&mail.headers, "From"),
            to: decode_header(&mail.headers, "To"),
            subject: decode_header(&mail.headers, "Subject"),
            date: decode_header(&mail.headers, "Date"),
            body: body_text(&mail),
        };
        let _ = session.logout();
        Ok(message)
    })
    .await
    .map_err(|_| "Reading email stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_terms_cannot_inject_imap_syntax() {
        assert_eq!(search_query(None, false).unwrap(), "ALL");
        assert_eq!(search_query(Some("  "), true).unwrap(), "UNSEEN");
        assert_eq!(
            search_query(Some("verification code"), true).unwrap(),
            "UNSEEN TEXT \"verification code\""
        );
        assert!(search_query(Some("a\" OR ALL"), false).is_err());
        assert!(search_query(Some("x\r\nA1 DELETE INBOX"), false).is_err());
    }

    #[test]
    fn credentials_require_a_real_host_and_password() {
        let mut credential = Credential {
            host: "imap.gmail.com".into(),
            port: 993,
            username: "me@example.com".into(),
            password: "x".repeat(16),
        };
        assert!(validate(&credential).is_ok());
        credential.host = "imap.gmail.com/evil".into();
        assert!(validate(&credential).is_err());
        credential.host = "imap.gmail.com".into();
        credential.password.clear();
        assert!(validate(&credential).is_err());
    }

    #[test]
    fn bodies_prefer_plain_text_and_fall_back_to_stripped_html() {
        let plain = b"Subject: Hi\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nYour code is 123456\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>ignored</p>\r\n--b--\r\n";
        let mail = mailparse::parse_mail(plain).unwrap();
        assert_eq!(body_text(&mail), "Your code is 123456");
        let html = b"Subject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hello&nbsp;<b>there</b></p>";
        let mail = mailparse::parse_mail(html).unwrap();
        assert_eq!(body_text(&mail), "Hello there");
    }
}
