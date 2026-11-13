//! Pre-fills sign-up and profile forms in the app's own site windows.
//!
//! The filled form stays visible and is never submitted: the user reviews it,
//! completes any captcha or verification step, and presses the button. Only
//! windows opened by the app on the supported social platforms and developer
//! sites can be filled. Password boxes get only the account's own saved password.

use std::{collections::HashMap, path::Path, sync::Mutex};

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
    // Developer sites of the guided developer-app setup.
    "console.cloud.google.com",
    "facebook.com",
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
    /// YYYY-MM-DD, filled into birthday dropdowns or date fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    birthday: Option<String>,
    /// Developer sites: the app or project name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app_name: Option<String>,
    /// Developer sites: the redirect or callback address of the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redirect_uri: Option<String>,
}

impl FormFields {
    fn values(&self) -> [&Option<String>; 13] {
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
            &self.birthday,
            &self.app_name,
            &self.redirect_uri,
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
    password: Option<String>,
    watch: bool,
    /// Overwrite values already on the page (editing an existing profile), once per field.
    replace: bool,
}

/// Fill scripts to re-run when a window loads its next page during sign-up.
static PENDING: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn remember(label: &str, script: Option<String>) {
    if let Ok(mut pending) = PENDING.lock() {
        let map = pending.get_or_insert_with(HashMap::new);
        match script {
            Some(script) => map.insert(label.to_owned(), script),
            None => map.remove(label),
        };
    }
}

/// Called by site windows after each page finishes loading.
pub fn page_loaded(window: &tauri::Webview) {
    let script = PENDING
        .lock()
        .ok()
        .and_then(|pending| pending.as_ref()?.get(window.label()).cloned());
    let on_platform = window.url().map(|url| platform_host(&url)).unwrap_or(false);
    if let (Some(script), true) = (script, on_platform) {
        let _ = window.eval(&script);
    }
}

pub fn window_closed(label: &str) {
    remember(label, None);
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
    if let Some(birthday) = fields.birthday.as_deref() {
        let parts: Vec<&str> = birthday.split('-').collect();
        let valid = parts.len() == 3
            && parts[0].len() == 4
            && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            && (1..=12).contains(&parts[1].parse::<u32>().unwrap_or(0))
            && (1..=31).contains(&parts[2].parse::<u32>().unwrap_or(0));
        if !valid {
            return Err("Birthday must be a date like 1995-04-23.".into());
        }
    }
    Ok(())
}

fn fill_script(payload: &FillPayload) -> Result<String, String> {
    let data = serde_json::to_string(payload).map_err(|_| "Could not prepare the form values.")?;
    Ok(format!("({FILL_SCRIPT})({data});"))
}

/// Matches visible inputs by autocomplete, type, name, label, and placeholder;
/// sets values the way typing would so React-based forms notice them; and
/// outlines what it filled. Only empty fields are filled (or, with `replace`,
/// each field once), so the user's own edits are kept. With `watch`, it keeps
/// filling fields that appear on later steps of the same page for a while.
///
/// The only things it clicks are birthday drop-downs (`role=combobox`) and the
/// matching month, day or year in them, as TikTok and Instagram draw those
/// menus themselves instead of using `<select>`. It never presses Next, Send
/// code, Sign up or any other button, and never submits a form. When a page
/// needs Nate (a puzzle, a phone check, TikTok's "finish in the app" QR code),
/// the banner says so instead. Each site's steps are in `docs/signup-flows.md`.
/// A verification code it is given also shows in a box at the bottom right
/// with a Copy button.
const FILL_SCRIPT: &str = r#"function (data) {
  const rules = [
    ['email', { types: ['email'], auto: ['email'], words: /e-?mail/ }],
    ['phone', { types: ['tel'], auto: ['tel'], words: /phone|mobile/ }],
    ['username', { auto: ['username'], words: /user ?name|handle/ }],
    ['firstName', { auto: ['given-name'], words: /first ?name|given/ }],
    ['lastName', { auto: ['family-name'], words: /last ?name|surname|family/ }],
    ['appName', { words: /app(lication)? name|project name/ }],
    ['displayName', { auto: ['nickname'], words: /display ?name|channel name|nickname/ }],
    ['fullName', { auto: ['name'], words: /full ?name|\bname\b/ }],
    ['bio', { words: /\bbio\b|description|about/ }],
    ['redirectUri', { words: /redirect|callback/ }],
    ['website', { types: ['url'], auto: ['url'], words: /website|\burl\b|link/ }],
    ['verificationCode', { auto: ['one-time-code'], words: /code|otp|verif/ }],
  ];
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const describe = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder,
    el.labels ? Array.from(el.labels).map((label) => label.textContent).join(' ') : '']
    .join(' ').toLowerCase();
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    done.add(el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.outline = '2px solid #8b5cf6';
  };
  // Fields filled once are left alone afterwards, so later page changes never undo the user's edits.
  const done = window.__socialspaceDone || (window.__socialspaceDone = new WeakSet());
  const fill = () => {
    const filled = [];
    const fields = Array.from(document.querySelectorAll('input, textarea')).filter((el) =>
      visible(el) && !el.disabled && !el.readOnly && (data.replace ? !done.has(el) : !el.value));
    const candidates = fields.filter((el) =>
      !['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].includes((el.type || '').toLowerCase()));
    const used = new Set();
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
    if (data.fields.birthday) {
      const [year, month, day] = data.fields.birthday.split('-').map(Number);
      const unset = (el) => el.selectedIndex <= 0 || el.value === '' || el.value === '0';
      const choose = (el, pick) => {
        const option = Array.from(el.options).find(pick);
        if (!option) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, option.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.style.outline = '2px solid #8b5cf6';
        return true;
      };
      let picked = false;
      for (const el of Array.from(document.querySelectorAll('select')).filter((el) => visible(el) && !el.disabled && unset(el))) {
        const text = (describe(el) + ' ' + (el.title || '')).toLowerCase();
        const label = (option) => option.text.trim().toLowerCase();
        if (/month/.test(text)) picked = choose(el, (o) => Number(o.value) === month || label(o).startsWith(months[month - 1])) || picked;
        else if (/year/.test(text)) picked = choose(el, (o) => o.value === String(year) || label(o) === String(year)) || picked;
        else if (/day/.test(text)) picked = choose(el, (o) => Number(o.value) === day || label(o) === String(day)) || picked;
      }
      for (const el of fields.filter((el) => (el.type || '').toLowerCase() === 'date')) { setValue(el, data.fields.birthday); picked = true; }
      // Google asks for the day and year as plain text boxes next to a month menu.
      for (const el of candidates.filter((el) => !used.has(el))) {
        const key = (el.name || el.id || el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (key === 'day') { setValue(el, String(day)); picked = true; }
        else if (key === 'year') { setValue(el, String(year)); picked = true; }
      }
      if (picked) filled.push('birthday');
    }
    if (data.password) {
      const boxes = fields.filter((el) => (el.type || '').toLowerCase() === 'password');
      boxes.forEach((el) => setValue(el, data.password));
      if (boxes.length) filled.push('password');
    }
    if (data.image && !window.__socialspaceImageSet) {
      const input = Array.from(document.querySelectorAll('input[type=file]'))
        .find((el) => !el.accept || /image/.test(el.accept));
      if (input) {
        const bytes = Uint8Array.from(atob(data.image.data), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], data.image.name, { type: data.image.mime }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        window.__socialspaceImageSet = true;
        filled.push('image');
      }
    }
    return filled;
  };
  // Birthday menus drawn by the site (TikTok, Instagram): open each one and pick the value, like a person would.
  const menuKey = (box) => {
    const text = (describe(box) + ' ' + (box.textContent || '')).toLowerCase();
    return /month/.test(text) ? 'month' : /year/.test(text) ? 'year' : /\bday\b/.test(text) ? 'day' : null;
  };
  const pickMenus = async () => {
    if (!data.fields.birthday || window.__socialspaceMenus) return [];
    window.__socialspaceMenus = true;
    const picked = [];
    try {
      const [year, month, day] = data.fields.birthday.split('-').map(Number);
      const wanted = {
        month: (text) => text.startsWith(months[month - 1]) || text === String(month),
        day: (text) => text === String(day) || text === String(day).padStart(2, '0'),
        year: (text) => text === String(year),
      };
      const boxes = Array.from(document.querySelectorAll('[role=combobox]')).filter((box) =>
        visible(box) && box.tagName !== 'INPUT' && !done.has(box) && /^(month|day|year)$/i.test((box.textContent || '').trim()));
      for (const box of boxes) {
        const key = menuKey(box);
        if (!key) continue;
        if (box.getAttribute('aria-expanded') !== 'true') box.click();
        await wait(250);
        const option = Array.from(document.querySelectorAll('[role=option]'))
          .find((item) => visible(item) && wanted[key]((item.textContent || '').trim().toLowerCase()));
        if (option) { option.click(); done.add(box); box.style.outline = '2px solid #8b5cf6'; picked.push(key); }
        else if (box.getAttribute('aria-expanded') === 'true') box.click();
        await wait(200);
      }
    } finally { window.__socialspaceMenus = false; }
    return picked.length ? ['birthday'] : [];
  };
  // Steps only Nate can do: the banner says what to do and the page is left alone.
  const hints = [
    [/continue on the tiktok app|scan (the |this )?qr code/i, 'TikTok wants this sign-up finished in its phone app. Open TikTok on your phone, tap the scan icon, scan this QR code and finish there. Your email, password and birthday are under Sign-up details in Social Space.'],
    [/drag the (slider|puzzle)|select \d+ objects|verify (that )?you(')?re (a )?human|not a robot|security check|captcha/i, 'Solve this check yourself, then press the button on the page.'],
    [/(enter|add) (a |your )?phone number|verify your phone/i, 'This step wants your own phone number. Type it yourself, then the code it texts you.'],
  ];
  const hint = () => {
    const text = (document.body.innerText || '').slice(0, 5000).replace(/’/g, "'");
    const found = hints.find(([test]) => test.test(text));
    if (found) return found[1];
    const send = Array.from(document.querySelectorAll('button, [role=button]'))
      .find((el) => visible(el) && /^(send|get) code$/i.test((el.textContent || '').trim()));
    return send && !data.fields.verificationCode ? 'Press Send code yourself. The code from your inbox is entered here when it arrives.' : '';
  };
  const showCode = (code) => {
    const box = document.getElementById('socialspace-code') || document.createElement('div');
    box.id = 'socialspace-code';
    box.replaceChildren();
    box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;display:flex;align-items:center;gap:10px;' +
      'background:#1f1530;color:#fff;padding:12px 14px;border-radius:12px;font:14px system-ui;box-shadow:0 8px 28px rgba(0,0,0,.35)';
    const label = document.createElement('span');
    label.textContent = 'Code';
    label.style.cssText = 'opacity:.7';
    const value = document.createElement('strong');
    value.textContent = code;
    value.style.cssText = 'font:600 20px ui-monospace,monospace;letter-spacing:2px;user-select:all';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.style.cssText = 'border:0;border-radius:8px;padding:6px 12px;background:#8b5cf6;color:#fff;font:600 13px system-ui;cursor:pointer';
    copy.addEventListener('click', () => {
      // Copying the selected code works in every site window; the clipboard API is the fallback.
      const range = document.createRange();
      range.selectNodeContents(value);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const copied = document.execCommand('copy');
      if (!copied && navigator.clipboard) navigator.clipboard.writeText(code).catch(() => undefined);
      copy.textContent = 'Copied';
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText = 'border:0;background:none;color:#fff;font:20px system-ui;cursor:pointer;opacity:.7';
    close.addEventListener('click', () => box.remove());
    box.append(label, value, copy, close);
    if (!box.isConnected) document.body.appendChild(box);
    clearTimeout(window.__socialspaceCodeTimer);
    window.__socialspaceCodeTimer = setTimeout(() => box.remove(), 10 * 60 * 1000);
  };
  const banner = (text) => {
    const box = document.getElementById('socialspace-fill-banner') || document.createElement('div');
    box.id = 'socialspace-fill-banner';
    box.textContent = text;
    box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);' +
      'background:#1f1530;color:#fff;padding:10px 16px;border-radius:10px;font:14px system-ui;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:90vw;pointer-events:none';
    if (!box.isConnected) document.body.appendChild(box);
    clearTimeout(window.__socialspaceBannerTimer);
    window.__socialspaceBannerTimer = setTimeout(() => box.remove(), 20000);
  };
  const report = (filled, always) => {
    const next = hint();
    if (next && next !== window.__socialspaceHint) banner(next);
    else if (filled.length) banner('Socialspace filled: ' + filled.join(', ') + '. Check it, then press the button yourself.');
    else if (always) banner('Socialspace is ready. Fields will fill as each step appears.');
    window.__socialspaceHint = next;
    if (filled.length) console.info('[Socialspace] filled', filled);
  };
  const step = async (always) => {
    const filled = fill();
    const menus = await pickMenus();
    report(filled.includes('birthday') ? filled : filled.concat(menus), always);
  };
  const ours = (node) => {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest('#socialspace-fill-banner, #socialspace-code'));
  };
  if (data.fields.verificationCode) showCode(data.fields.verificationCode);
  window.__socialspaceHint = '';
  step(true);
  if (window.__socialspaceObserver) window.__socialspaceObserver.disconnect();
  if (data.watch) {
    let timer;
    const observer = new MutationObserver((changes) => {
      // The banner and code box changing are not a new step of the sign-up.
      if (changes.every((change) => ours(change.target) || Array.from(change.addedNodes).concat(Array.from(change.removedNodes)).some(ours))) return;
      clearTimeout(timer);
      timer = setTimeout(() => step(false), 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__socialspaceObserver = observer;
    setTimeout(() => observer.disconnect(), 10 * 60 * 1000);
  }
}"#;

#[tauri::command]
pub fn fill_site_form(
    app: AppHandle,
    window_label: String,
    fields: FormFields,
    image_path: Option<String>,
    account_id: Option<String>,
    include_password: Option<bool>,
    keep_filling: Option<bool>,
    replace: Option<bool>,
) -> Result<(), String> {
    validate(&fields)?;
    if !window_label.starts_with("site-") {
        return Err("That window cannot be filled.".into());
    }
    let window = app
        .get_webview(&window_label)
        .ok_or("That page is closed. Open it again.")?;
    let url = window.url().map_err(|_| "Could not read the page address.")?;
    // Right after opening, the page may still be blank; it is filled when it finishes loading.
    let still_loading = url.scheme() == "about" || url.host_str().is_none();
    if !still_loading && !platform_host(&url) {
        return Err("Forms can only be filled on X, Instagram, TikTok, or YouTube pages.".into());
    }
    let image = match image_path.as_deref().filter(|path| !path.is_empty()) {
        Some(path) => {
            let (name, mime, bytes) = read_image(path)?;
            Some(ImagePayload { name, mime, data: STANDARD.encode(bytes) })
        }
        None => None,
    };
    let password = if include_password.unwrap_or(false) {
        let id = account_id.as_deref().ok_or("Choose the account whose password to use.")?;
        Some(crate::account_passwords::read(id)?.ok_or("No password is saved for this account yet.")?)
    } else {
        None
    };
    let watch = keep_filling.unwrap_or(false);
    let replace = replace.unwrap_or(false);
    let script = fill_script(&FillPayload { fields: &fields, image, password, watch, replace })?;
    if still_loading {
        remember(&window_label, Some(script));
        return Ok(());
    }
    remember(&window_label, watch.then(|| script.clone()));
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
        let script = fill_script(&FillPayload { fields: &fields, image: None, password: None, watch: false, replace: true }).unwrap();
        assert!(script.contains(r#""replace":true"#));
        assert!(script.contains(r#""bio":"Quote \" and </script> stay data""#));
        assert!(!script.contains("\"email\""));
        assert!(!script.contains(".submit("));
        assert!(!script.contains("requestSubmit"));
        // Only birthday menus and their options are ever clicked; never a button.
        for line in script.lines().filter(|line| line.contains(".click(")) {
            assert!(
                line.contains("box.click()") || line.contains("option.click()"),
                "unexpected click: {line}"
            );
        }
        assert!(script.contains(r#""password":null"#));
        assert!(script.contains("[role=combobox]"));
        assert!(script.contains("continue on the tiktok app"));
    }

    #[test]
    fn images_must_be_supported_types() {
        assert_eq!(image_mime(Path::new("me.PNG")), Some("image/png"));
        assert_eq!(image_mime(Path::new("me.jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("me.exe")), None);
        assert!(read_image("/definitely/missing.png").is_err());
    }

    #[test]
    fn developer_app_details_are_accepted() {
        let fields: FormFields = serde_json::from_value(serde_json::json!({ "appName": "SocialSpace", "redirectUri": "https://localhost/socialspace/tiktok" })).unwrap();
        assert!(validate(&fields).is_ok());
        let script = fill_script(&FillPayload { fields: &fields, image: None, password: None, watch: false, replace: false }).unwrap();
        assert!(script.contains("\"redirectUri\":\"https://localhost/socialspace/tiktok\""));
        assert!(platform_host(&"https://developers.facebook.com/apps/".parse().unwrap()));
        assert!(platform_host(&"https://console.cloud.google.com/apis/credentials".parse().unwrap()));
        assert!(!platform_host(&"https://example.com/".parse().unwrap()));
    }

    #[test]
    fn birthdays_must_be_real_dates() {
        let ok = FormFields { birthday: Some("1995-04-23".into()), ..Default::default() };
        assert!(validate(&ok).is_ok());
        for bad in ["1995-13-01", "95-04-23", "1995-04-00", "1995/04/23", "x"] {
            let fields = FormFields { birthday: Some(bad.into()), ..Default::default() };
            assert!(validate(&fields).is_err(), "{bad}");
        }
    }

    #[test]
    fn unknown_fields_and_long_values_are_rejected() {
        assert!(serde_json::from_str::<FormFields>(r#"{"password":"x"}"#).is_err());
        let fields = FormFields { bio: Some("a".repeat(3_000)), ..Default::default() };
        assert!(validate(&fields).is_err());
    }
}
