//! Shows a platform page inside the main window (for the Create accounts
//! wizard) instead of a separate window. Only one embedded page is open at a
//! time. It follows the same navigation rules and form filling as site windows.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use serde::Deserialize;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

static NEXT: AtomicU64 = AtomicU64::new(1);
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// Where the page sits, in CSS pixels from the top-left of the app window.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    fn checked(self) -> Result<Self, String> {
        let finite = [self.x, self.y, self.width, self.height].iter().all(|value| value.is_finite());
        if !finite || self.x < 0.0 || self.y < 0.0 || self.width < 50.0 || self.height < 50.0 {
            return Err("The page area is too small to show the site.".into());
        }
        Ok(self)
    }
}

fn close_current(app: &AppHandle) {
    let previous = CURRENT.lock().ok().and_then(|mut current| current.take());
    if let Some(label) = previous {
        crate::autofill::window_closed(&label);
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
}

/// Opens a platform page inside the app window and returns its id for filling.
#[tauri::command]
pub async fn embed_platform_page(
    app: AppHandle,
    platform: crate::Platform,
    action: String,
    bounds: Bounds,
) -> Result<String, String> {
    let address = crate::platform_url(platform, &action).ok_or("Unknown platform action.")?;
    embed_address(&app, address, bounds, false)
}

/// Opens one of the fixed developer setup pages (see `setup_pages::page_url`) inside the app
/// window, for the guided developer-app setup. Only known pages open, never a free-form URL.
#[tauri::command]
pub async fn embed_setup_page(app: AppHandle, page: String, bounds: Bounds) -> Result<String, String> {
    let address = crate::setup_pages::page_url(&page).ok_or("That setup page is not known.")?;
    embed_address(&app, address, bounds, true)
}

/// How far developer sites are zoomed out inside the guide.
const SETUP_ZOOM: f64 = 0.8;

/// Darkens light developer sites to match the app: inverts the page and turns pictures back.
/// Pages that are already dark (TikTok's sign-in, for one) are left as they are.
const DARK_SCRIPT: &str = r#"(() => {
  const id = 'socialspace-dark';
  const css = 'html{filter:invert(.9) hue-rotate(180deg)!important;background:#fff!important}' +
    'img,video,picture,canvas,iframe,embed,object,[style*="background-image"],#socialspace-fill-banner,#socialspace-code,[data-ss-keep]' +
    '{filter:invert(1) hue-rotate(180deg)!important}' +
    '[data-ss-keep] :is(img,video,picture,canvas,iframe,embed,object,[style*="background-image"]){filter:none!important}';
  const add = () => {
    if (document.getElementById(id) || !document.documentElement) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  const level = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // How light an element's own background is (0 dark to 1 light), from its colour or gradient; null if none.
  const shade = (el) => {
    if (!el) return null;
    const css = getComputedStyle(el);
    const match = css.backgroundColor.match(/[\d.]+/g);
    if (match && !(match.length > 3 && Number(match[3]) === 0)) return level(...match.map(Number));
    if (!/gradient/.test(css.backgroundImage)) return null;
    const stops = Array.from(css.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)).map((stop) => stop[1].split(',').map(Number))
      .filter((stop) => stop.length < 4 || stop[3] > 0);
    return stops.length ? stops.reduce((sum, stop) => sum + level(stop[0], stop[1], stop[2]), 0) / stops.length : null;
  };
  // The page's backdrop: the first background found under a few points of the window, else the body's.
  const backdrop = () => {
    for (const [x, y] of [[0.25, 0.5], [0.5, 0.6], [0.75, 0.4]]) {
      for (const el of document.elementsFromPoint(innerWidth * x, innerHeight * y)) {
        if (el.closest('#socialspace-fill-banner, #socialspace-code')) continue;
        const found = shade(el);
        if (found !== null) return found;
      }
    }
    return shade(document.body) ?? shade(document.documentElement) ?? 1;
  };
  const check = () => {
    const style = document.getElementById(id);
    if (!style || !document.body) return;
    style.disabled = false;
    document.querySelectorAll('[data-ss-keep]').forEach((el) => el.removeAttribute('data-ss-keep'));
    style.disabled = backdrop() < 0.4;
    if (style.disabled) return;
    // Parts the site already draws dark (a black header, say) are turned back so they stay dark. A filter
    // would trap fixed or sticky children (headers, menus) inside its box, so boxes holding them are skipped.
    const all = Array.from(document.body.querySelectorAll('*')).slice(0, 4000);
    const pinned = all.filter((el) => /fixed|sticky/.test(getComputedStyle(el).position));
    for (const el of all) {
      if (el.closest('[data-ss-keep]') || el.offsetWidth < 300) continue;
      if (pinned.some((pin) => pin !== el && el.contains(pin))) continue;
      const level = shade(el);
      if (level !== null && level < 0.3) el.setAttribute('data-ss-keep', '');
    }
  };
  add();
  document.addEventListener('DOMContentLoaded', () => { add(); check(); });
  window.addEventListener('load', () => { check(); setTimeout(check, 1500); setTimeout(check, 4000); });
})();"#;

fn embed_address(app: &AppHandle, address: &str, bounds: Bounds, dark: bool) -> Result<String, String> {
    let bounds = bounds.checked()?;
    let url: url::Url = address.parse().map_err(|_| "Invalid website address.")?;
    let window = app.get_window("main").ok_or("The app window is not ready yet.")?;
    close_current(app);
    let label = format!("site-embed-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let popup_app = app.clone();
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url));
    if dark {
        builder = builder.initialization_script(DARK_SCRIPT);
    }
    let builder = builder
        .on_navigation(|url| crate::browser::allowed_navigation(url, false))
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                crate::autofill::page_loaded(&webview);
            }
        })
        .on_new_window(move |url, features| {
            // Pop-ups (for example "Sign in with Google") still open as their own window.
            if !crate::browser::allowed_navigation(&url, false) {
                return NewWindowResponse::Deny;
            }
            let blank = "about:blank".parse().expect("valid blank URL");
            match crate::browser::make_window(&popup_app, blank, false, Some(features)) {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|_| "Could not show the site inside the app.")?;
    if dark {
        // Developer consoles are laid out for wide screens; zooming out gives them room, so buttons on
        // the right (TikTok's "Connect an app") show instead of sitting past a sideways scroll.
        let _ = webview.set_zoom(SETUP_ZOOM);
    }
    if let Ok(mut current) = CURRENT.lock() {
        *current = Some(label.clone());
    }
    Ok(label)
}

/// Moves the embedded page when the wizard's page area changes size.
#[tauri::command]
pub fn set_embedded_bounds(app: AppHandle, label: String, bounds: Bounds) -> Result<(), String> {
    let bounds = bounds.checked()?;
    if !label.starts_with("site-embed-") {
        return Err("Unknown page.".into());
    }
    let webview = app.get_webview(&label).ok_or("That page is closed.")?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|_| webview.set_size(LogicalSize::new(bounds.width, bounds.height)))
        .map_err(|_| "Could not resize the site.".into())
}

#[tauri::command]
pub fn close_embedded_page(app: AppHandle) -> Result<(), String> {
    close_current(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_must_be_a_real_area() {
        let ok = Bounds { x: 300.0, y: 80.0, width: 800.0, height: 600.0 };
        assert!(ok.checked().is_ok());
        assert!(Bounds { width: 10.0, ..ok }.checked().is_err());
        assert!(Bounds { x: f64::NAN, ..ok }.checked().is_err());
        assert!(Bounds { y: -5.0, ..ok }.checked().is_err());
    }
}
