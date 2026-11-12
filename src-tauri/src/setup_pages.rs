//! Opens the developer and account pages the setup tracker points to. Only these fixed
//! addresses can be opened, so the interface never passes a free-form URL.

use tauri::AppHandle;

/// The page for each setup step, by the key the interface uses.
pub(crate) fn page_url(page: &str) -> Option<&'static str> {
    Some(match page {
        "meta-apps" => "https://developers.facebook.com/apps/",
        "meta-business" => "https://business.facebook.com/settings",
        "instagram-settings" => "https://www.instagram.com/accounts/edit/",
        "google-consent" => "https://console.cloud.google.com/apis/credentials/consent",
        "google-youtube-api" => "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
        "google-quota" => "https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas",
        "youtube-audit" => "https://support.google.com/youtube/contact/yt_api_form",
        "youtube-verify" => "https://www.youtube.com/verify",
        "tiktok-apps" => "https://developers.tiktok.com/apps/",
        "tiktok-login" => "https://developers.tiktok.com/login/",
        "google-project" => "https://console.cloud.google.com/projectcreate",
        "google-credentials" => "https://console.cloud.google.com/apis/credentials",
        "google-new-client" => "https://console.cloud.google.com/auth/clients/create",
        "x-signup" => "https://developer.x.com/en/portal/petition/essential/basic-info",
        "x-portal" => "https://developer.x.com/en/portal/dashboard",
        "x-products" => "https://developer.x.com/en/portal/products",
        _ => return None,
    })
}

/// Opens one of the setup pages in an app window.
#[tauri::command]
pub async fn open_setup_page(app: AppHandle, page: String) -> Result<(), String> {
    let url = page_url(&page).ok_or("That setup page is not known.")?;
    crate::browser::open_remote(&app, url, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_https_pages_open() {
        assert_eq!(page_url("tiktok-apps"), Some("https://developers.tiktok.com/apps/"));
        assert_eq!(page_url("https://evil.example"), None);
        for page in ["meta-apps", "meta-business", "instagram-settings", "google-consent", "google-youtube-api", "google-quota", "youtube-audit", "youtube-verify", "tiktok-apps", "x-portal", "x-products", "tiktok-login", "google-project", "google-credentials", "google-new-client", "x-signup"] {
            assert!(page_url(page).unwrap().starts_with("https://"), "{page}");
        }
    }
}
