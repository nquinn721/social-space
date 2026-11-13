use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{
    webview::{NewWindowFeatures, NewWindowResponse},
    AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);
const OAUTH_CALLBACK_PORT: u16 = 49173;

pub(crate) fn allowed_navigation(url: &url::Url, oauth_callback: bool) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if oauth_callback
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(OAUTH_CALLBACK_PORT)
        && url.path() == "/callback"
    {
        return true;
    }
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.');
            host.contains('.') && !host.ends_with(".localhost") && !host.ends_with(".local")
        }
        _ => false,
    }
}

/// TikTok's sign-in always opens on its email-and-password form, never the choice screen (QR code,
/// Google, phone): the page the app can fill with the profile's saved login. Keeps `redirect_url`.
pub(crate) fn email_login_page(url: &url::Url) -> Option<url::Url> {
    let host = url.host_str()?.trim_start_matches("www.");
    if url.scheme() != "https" || host != "tiktok.com" {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    if path != "/login" && !path.starts_with("/login/") || path.starts_with("/login/phone-or-email/email") {
        return None;
    }
    let mut next = url.clone();
    next.set_path("/login/phone-or-email/email");
    Some(next)
}

/// Sends a page that loaded on a sign-in choice screen to the email form instead.
pub(crate) fn to_email_login(webview: &tauri::Webview) -> bool {
    match webview.url().ok().as_ref().and_then(email_login_page) {
        Some(next) => webview.navigate(next).is_ok(),
        None => false,
    }
}

pub(crate) fn make_window(
    app: &AppHandle,
    url: url::Url,
    oauth_callback: bool,
    features: Option<NewWindowFeatures>,
) -> Result<WebviewWindow, String> {
    let label = format!("site-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let popup_app = app.clone();
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Socialspace · Website")
        .inner_size(1100.0, 800.0)
        .on_navigation(move |url| allowed_navigation(url, oauth_callback))
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished && !to_email_login(window.as_ref()) {
                crate::autofill::page_loaded(window.as_ref());
            }
        })
        .on_new_window(move |url, features| {
            if !allowed_navigation(&url, oauth_callback) {
                return NewWindowResponse::Deny;
            }
            let blank = "about:blank".parse().expect("valid blank URL");
            match make_window(&popup_app, blank, oauth_callback, Some(features)) {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        });
    let builder = if let Some(features) = features {
        builder.window_features(features)
    } else {
        builder
    };
    let window = builder
        .build()
        .map_err(|_| "Could not open the website inside the app.")?;
    let closed = window.label().to_owned();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            crate::autofill::window_closed(&closed);
        }
    });
    Ok(window)
}

pub fn open_remote(app: &AppHandle, address: &str, oauth_callback: bool) -> Result<(), String> {
    open_remote_window(app, address, oauth_callback).map(|_| ())
}

/// Opens a site window and returns its label so the assistant can pre-fill it later.
pub fn open_remote_window(app: &AppHandle, address: &str, oauth_callback: bool) -> Result<String, String> {
    let url: url::Url = address.parse().map_err(|_| "Invalid website address.")?;
    if !allowed_navigation(&url, oauth_callback) || url.scheme() != "https" {
        return Err("The website address is not allowed.".into());
    }
    make_window(app, url, oauth_callback, None).map(|window| window.label().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiktok_sign_in_goes_straight_to_the_email_form() {
        let next = |value: &str| email_login_page(&value.parse().unwrap()).map(|url| url.to_string());
        assert_eq!(next("https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fwww.tiktok.com%2Ftiktokstudio%2Fupload").as_deref(),
            Some("https://www.tiktok.com/login/phone-or-email/email?redirect_url=https%3A%2F%2Fwww.tiktok.com%2Ftiktokstudio%2Fupload"));
        assert_eq!(next("https://www.tiktok.com/login/qrcode").as_deref(), Some("https://www.tiktok.com/login/phone-or-email/email"));
        assert_eq!(next("https://www.tiktok.com/login/phone-or-email").as_deref(), Some("https://www.tiktok.com/login/phone-or-email/email"));
        assert!(next("https://www.tiktok.com/login/phone-or-email/email").is_none());
        assert!(next("https://www.tiktok.com/loginx").is_none());
        assert!(next("https://www.tiktok.com/tiktokstudio/upload").is_none());
        assert!(next("https://x.com/login").is_none());
    }

    #[test]
    fn navigation_rejects_local_resources_and_limits_oauth_callback() {
        let allowed = |value: &str, oauth| allowed_navigation(&value.parse().unwrap(), oauth);
        assert!(allowed("https://www.youtube.com/", false));
        assert!(allowed("about:blank", false));
        assert!(!allowed("http://tauri.localhost/", false));
        assert!(!allowed("https://tauri.localhost/", false));
        assert!(!allowed("file:///C:/secret", false));
        assert!(!allowed("https://127.0.0.1/", false));
        assert!(!allowed("http://127.0.0.1:49173/callback?code=x", false));
        assert!(allowed("http://127.0.0.1:49173/callback?code=x", true));
        assert!(!allowed("http://127.0.0.1:49173/other", true));
    }
}
