//! Pre-fills sign-up and profile forms in the app's own site windows.
//!
//! The filled form stays visible and is never submitted: the user reviews it,
//! completes any captcha or verification step, and presses the button. Only
//! windows opened by the app on the supported social platforms can be filled,
//! and password fields are never touched.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FIELD_CHARS: usize = 2_200;
const PLATFORM_HOSTS: &[&str] = &[
    "x.com",
    "twitter.com",
    "instagram.com",
    "tiktok.com",
    "youtube.com",
    "accounts.google.com",
];

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    phone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    website: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    verification_code: Option<String>,
}

impl FormFields {
    fn values(&self) -> [&Option<String>; 10] {
        [
            &self.email,
            &self.phone,
            &self.username,
            &self.first_name,
            &self.last_name,
            &self.display_name,
            &self.full_name,
            &self.bio,
            &self.website,
            &self.verification_code,
        ]
    }
}

#[derive(Serialize)]
struct ImagePayload {
    name: String,
    mime: &'static str,
    data: String,
}

#[derive(Serialize)]
struct FillPayload<'a> {
    fields: &'a FormFields,
    image: Option<ImagePayload>,
}

fn platform_host(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            PLATFORM_HOSTS
                .iter()
                .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
        })
}

fn image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn read_image(path: &str) -> Result<(String, &'static str, Vec<u8>), String> {
    let path = Path::new(path);
    let mime = image_mime(path).ok_or("Use a PNG, JPG, or WebP image.")?;
    let size = std::fs::metadata(path)
        .map_err(|_| "Could not find that image. Choose it again.")?
        .len();
    if size == 0 || size > MAX_IMAGE_BYTES {
        return Err("Images must be smaller than 8 MB.".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Could not read that image.")?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("profile.png")
        .to_owned();
    Ok((name, mime, bytes))
}

fn validate(fields: &FormFields) -> Result<(), String> {
    let too_long = fields.values().iter().any(|value| {
        value
            .as_ref()
            .is_some_and(|value| value.chars().count() > MAX_FIELD_CHARS)
    });
    if too_long {
        return Err("A form value is too long.".into());
    }
    Ok(())
}

fn fill_script(payload: &FillPayload) -> Result<String, String> {
    let data = serde_json::to_string(payload).map_err(|_| "Could not prepare the form values.")?;
    Ok(format!("({FILL_SCRIPT})({data});"))
}

/// Matches visible inputs by autocomplete, type, name, label, and placeholder;
/// sets values the way typing would so React-based forms notice them; and
/// outlines what it filled. It never clicks or submits anything.
const FILL_SCRIPT: &str = r#"function (data) {
  const rules = [
    ['email', { types: ['email'], auto: ['email'], words: /e-?mail/ }],
    ['phone', { types: ['tel'], auto: ['tel'], words: /phone|mobile/ }],
    ['username', { auto: ['username'], words: /user ?name|handle/ }],
    ['firstName', { auto: ['given-name'], words: /first ?name|given/ }],
    ['lastName', { auto: ['family-name'], words: /last ?name|surname|family/ }],
    ['displayName', { auto: ['nickname'], words: /display ?name|channel name|nickname/ }],
    ['fullName', { auto: ['name'], words: /full ?name|\bname\b/ }],
    ['bio', { words: /\bbio\b|description|about/ }],
    ['website', { types: ['url'], auto: ['url'], words: /website|\burl\b|link/ }],
    ['verificationCode', { auto: ['one-time-code'], words: /code|otp|verif/ }],
  ];
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const candidates = Array.from(document.querySelectorAll('input, textarea')).filter((el) =>
    visible(el) && !el.disabled && !el.readOnly &&
    !['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes((el.type || '').toLowerCase()));
  const describe = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder,
    el.labels ? Array.from(el.labels).map((label) => label.textContent).join(' ') : '']
    .join(' ').toLowerCase();
  const used = new Set();
  const filled = [];
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.outline = '2px solid #8b5cf6';
  };
  for (const [key, rule] of rules) {
    const value = data.fields[key];
    if (typeof value !== 'string' || !value) continue;
    const match = (test) => candidates.find((el) => !used.has(el) && test(el));
    const el = match((el) => (rule.auto || []).includes((el.getAttribute('autocomplete') || '').toLowerCase()))
      || match((el) => (rule.types || []).includes((el.type || '').toLowerCase()))
      || match((el) => rule.words.test(describe(el)));
    if (!el) continue;
    used.add(el);
    setValue(el, value);
    filled.push(key);
  }
  if (data.image) {
    const input = Array.from(document.querySelectorAll('input[type=file]'))
      .find((el) => !el.accept || /image/.test(el.accept));
    if (input) {
      const bytes = Uint8Array.from(atob(data.image.data), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], data.image.name, { type: data.image.mime }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push('image');
    }
  }
  const banner = document.getElementById('socialspace-fill-banner') || document.createElement('div');
  banner.id = 'socialspace-fill-banner';
  banner.textContent = filled.length
    ? 'Socialspace filled: ' + filled.join(', ') + '. Review everything, then submit it yourself.'
    : 'Socialspace could not find matching fields on this page.';
  banner.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);' +
    'background:#1f1530;color:#fff;padding:10px 16px;border-radius:10px;font:14px system-ui;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:90vw';
  if (!banner.isConnected) document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 15000);
  console.info('[Socialspace] filled', filled);
}"#;

#[tauri::command]
pub fn fill_site_form(
    app: AppHandle,
    window_label: String,
    fields: FormFields,
    image_path: Option<String>,
) -> Result<(), String> {
    validate(&fields)?;
    if !window_label.starts_with("site-") {
        return Err("That window cannot be filled.".into());
    }
    let window = app
        .get_webview_window(&window_label)
        .ok_or("That window is closed. Open the page again.")?;
    let url = window.url().map_err(|_| "Could not read the window address.")?;
    if !platform_host(&url) {
        return Err("Forms can only be filled on X, Instagram, TikTok, or YouTube pages.".into());
    }
    let image = match image_path.as_deref().filter(|path| !path.is_empty()) {
        Some(path) => {
            let (name, mime, bytes) = read_image(path)?;
            Some(ImagePayload { name, mime, data: STANDARD.encode(bytes) })
        }
        None => None,
    };
    let script = fill_script(&FillPayload { fields: &fields, image })?;
    window
        .eval(&script)
        .map_err(|_| "Could not fill the form in that window.".into())
}

#[tauri::command]
pub async fn choose_image_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a profile image")
            .add_filter("Image", &["png", "jpg", "jpeg", "webp"])
            .pick_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Could not open the file picker.".into())
}

/// Returns a data URL for previewing a chosen profile image in the app.
#[tauri::command]
pub fn load_image_preview(path: String) -> Result<String, String> {
    let (_, mime, bytes) = read_image(&path)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_platform_pages_can_be_filled() {
        let ok = |value: &str| platform_host(&value.parse().unwrap());
        assert!(ok("https://www.instagram.com/accounts/emailsignup/"));
        assert!(ok("https://x.com/i/flow/signup"));
        assert!(ok("https://accounts.google.com/signup"));
        assert!(!ok("https://instagram.com.evil.example/"));
        assert!(!ok("https://notx.com/"));
        assert!(!ok("http://x.com/"));
        assert!(!ok("https://google.com/"));
    }

    #[test]
    fn script_embeds_values_as_json_and_skips_empty_fields() {
        let fields = FormFields {
            bio: Some("Quote \" and </script> stay data".into()),
            ..Default::default()
        };
        let script = fill_script(&FillPayload { fields: &fields, image: None }).unwrap();
        assert!(script.contains(r#""bio":"Quote \" and </script> stay data""#));
        assert!(!script.contains("\"email\""));
        assert!(!script.contains(".submit("));
        assert!(!script.contains(".click("));
    }

    #[test]
    fn images_must_be_supported_types() {
        assert_eq!(image_mime(Path::new("me.PNG")), Some("image/png"));
        assert_eq!(image_mime(Path::new("me.jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("me.exe")), None);
        assert!(read_image("/definitely/missing.png").is_err());
    }

    #[test]
    fn unknown_fields_and_long_values_are_rejected() {
        assert!(serde_json::from_str::<FormFields>(r#"{"password":"x"}"#).is_err());
        let fields = FormFields { bio: Some("a".repeat(3_000)), ..Default::default() };
        assert!(validate(&fields).is_err());
    }
}
