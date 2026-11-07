use serde::{Deserialize, Serialize};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use url::{Host, Url};

// The Facebook Login path requires a Page token and a linked professional IG account.
const API_BASE: &str = "https://graph.facebook.com/v25.0";
const KEYRING_SERVICE: &str = "social-manager-instagram-page";
const KEYRING_ENTRY: &str = "primary";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_POLLS: usize = 60;
const MAX_CAPTION_LENGTH: usize = 2_200;
static ACTIVE: AtomicBool = AtomicBool::new(false);

struct Guard;
impl Guard {
    fn acquire() -> Result<Self, String> {
        ACTIVE
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "An Instagram operation is already in progress.".to_string())?;
        Ok(Self)
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

#[derive(Serialize, Deserialize)]
struct Credential {
    id: String,
    username: String,
    access_token: String,
}
#[derive(Serialize, Deserialize)]
pub struct InstagramConnection {
    id: String,
    username: String,
}
#[derive(Deserialize, Serialize)]
pub struct InstagramPost {
    id: String,
}
#[derive(Deserialize)]
struct ContainerStatus {
    status_code: String,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ENTRY)
        .map_err(|_| "Could not access secure credential storage.".into())
}
fn load() -> Result<Option<Credential>, String> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
            "Saved Instagram credentials could not be read. Disconnect and reconnect.".into()
        }),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read Instagram credentials from secure storage.".into()),
    }
}
fn save(value: &Credential) -> Result<(), String> {
    let value =
        serde_json::to_string(value).map_err(|_| "Could not encode Instagram credentials.")?;
    entry()?
        .set_password(&value)
        .map_err(|_| "Could not save Instagram credentials in secure storage.".into())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start the network client.".into())
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit())
}
fn container_ready(status: &str) -> Result<bool, String> {
    match status {
        "FINISHED" => Ok(true),
        "IN_PROGRESS" => Ok(false),
        "ERROR" | "EXPIRED" | "PUBLISHED" => {
            Err("Instagram could not prepare the Reel. No publish request was sent.".into())
        }
        _ => Err(
            "Instagram returned an unknown processing status. No publish request was sent.".into(),
        ),
    }
}
fn validate_video_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "Enter a public HTTPS video URL.")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Enter a public HTTPS video URL without credentials or a fragment.".into());
    }
    match url.host() {
        Some(Host::Domain(name))
            if name.contains('.')
                && !name.ends_with(".local")
                && !name.eq_ignore_ascii_case("localhost") =>
        {
            Ok(())
        }
        _ => Err("Enter a public HTTPS video URL with a domain name.".into()),
    }
}
async fn result<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    stage: &str,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!("Instagram {stage} failed (HTTP {}). Check the account, Meta permissions, token, and video requirements.", response.status().as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| format!("Instagram returned an unreadable {stage} response."))
}

#[tauri::command]
pub async fn connect_instagram(
    account_id: String,
    access_token: String,
) -> Result<InstagramConnection, String> {
    let _guard = Guard::acquire()?;
    let account_id = account_id.trim();
    let access_token = access_token.trim();
    if !valid_id(account_id)
        || access_token.is_empty()
        || access_token.len() > 4096
        || access_token.chars().any(char::is_whitespace)
    {
        return Err(
            "Enter a numeric Instagram professional account ID and a Meta Page access token."
                .into(),
        );
    }
    let response = client()?
        .get(format!("{API_BASE}/{account_id}"))
        .query(&[("fields", "id,username")])
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| "Could not reach Meta to verify the Instagram account.")?;
    let account: InstagramConnection = result(response, "account lookup").await?;
    if account.id != account_id || account.username.is_empty() {
        return Err("Meta returned an unexpected Instagram account. Check your account ID.".into());
    }
    save(&Credential {
        id: account.id.clone(),
        username: account.username.clone(),
        access_token: access_token.into(),
    })?;
    Ok(account)
}

#[tauri::command]
pub fn instagram_connection() -> Result<Option<InstagramConnection>, String> {
    Ok(load()?.map(|c| InstagramConnection {
        id: c.id,
        username: c.username,
    }))
}

#[tauri::command]
pub fn disconnect_instagram() -> Result<(), String> {
    let _guard = Guard::acquire()?;
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove Instagram credentials from secure storage.".into()),
    }
}

// This operation never automatically retries the final publishing request: its outcome can be ambiguous.
#[tauri::command]
pub async fn publish_instagram_reel(
    video_url: String,
    caption: String,
) -> Result<InstagramPost, String> {
    let _guard = Guard::acquire()?;
    validate_video_url(&video_url)?;
    if caption.chars().count() > MAX_CAPTION_LENGTH {
        return Err("Instagram captions must be 2,200 characters or fewer.".into());
    }
    let credential =
        load()?.ok_or("Connect your Instagram professional account before publishing.")?;
    if !valid_id(&credential.id) {
        return Err("Saved Instagram account ID is invalid. Reconnect your account.".into());
    }
    let http = client()?;
    let response = http
        .post(format!("{API_BASE}/{}/media", credential.id))
        .bearer_auth(&credential.access_token)
        .form(&[
            ("media_type", "REELS"),
            ("video_url", video_url.as_str()),
            ("caption", caption.as_str()),
        ])
        .send()
        .await
        .map_err(|_| {
            "Could not create the Instagram Reel container. No publish request was sent."
        })?;
    let container: InstagramPost = result(response, "container creation").await?;
    if !valid_id(&container.id) {
        return Err(
            "Instagram returned an invalid container ID. No publish request was sent.".into(),
        );
    }
    let mut ready = false;
    for attempt in 0..MAX_POLLS {
        if attempt > 0 {
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(POLL_INTERVAL))
                .await
                .map_err(|_| {
                    "Instagram processing check was interrupted. No publish request was sent."
                })?;
        }
        let response = http
            .get(format!("{API_BASE}/{}", container.id))
            .query(&[("fields", "status_code")])
            .bearer_auth(&credential.access_token)
            .send()
            .await
            .map_err(|_| "Could not check Instagram processing. No publish request was sent.")?;
        let status: ContainerStatus = result(response, "processing check").await?;
        if container_ready(&status.status_code)? {
            ready = true;
            break;
        }
    }
    if !ready {
        return Err(
            "Instagram is still processing the Reel. No publish request was sent; try again later."
                .into(),
        );
    }
    let response = http.post(format!("{API_BASE}/{}/media_publish", credential.id))
        .bearer_auth(&credential.access_token).form(&[("creation_id", container.id.as_str())]).send().await
        .map_err(|_| "Instagram publish outcome is unknown. Check Instagram before retrying; the Reel may have been published.")?;
    if !response.status().is_success() {
        return Err(format!("Instagram returned HTTP {} when publishing. Check Instagram before retrying; the Reel may have been published.", response.status().as_u16()));
    }
    response.json().await.map_err(|_| "Instagram's publish response was unreadable. Check Instagram before retrying; the Reel may have been published.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_finished_containers_can_be_published() {
        assert_eq!(container_ready("FINISHED"), Ok(true));
        assert_eq!(container_ready("IN_PROGRESS"), Ok(false));
        for status in ["ERROR", "EXPIRED", "PUBLISHED", "UNEXPECTED"] {
            assert!(container_ready(status).is_err());
        }
    }
    #[test]
    fn account_and_container_ids_must_be_numeric() {
        assert!(valid_id("17841400000000000"));
        for id in ["", "../me", "1?x=2", " 123", "abc"] {
            assert!(!valid_id(id));
        }
    }
    #[test]
    fn video_url_rejects_credentials_and_local_hosts() {
        assert!(validate_video_url("https://media.example.com/reel.mp4?signature=abc").is_ok());
        for url in [
            "http://example.com/a.mp4",
            "https://user:pass@example.com/a.mp4",
            "https://localhost/a.mp4",
            "https://127.0.0.1/a.mp4",
            "https://example.local/a.mp4",
            "https://example.com/a#fragment",
        ] {
            assert!(validate_video_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn client_rejects_plain_http() {
        tauri::async_runtime::block_on(async {
            assert!(client()
                .unwrap()
                .get("http://127.0.0.1:1")
                .send()
                .await
                .unwrap_err()
                .is_builder());
        });
    }
}
