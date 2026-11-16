import { invoke, isTauri } from '@tauri-apps/api/core';

/** The Facebook Page a brand's Facebook profile posts Reels to. */
export type FacebookPage = { id: string; name: string };
/** permalink: the live Reel on facebook.com. */
export type PublishedReel = { id: string; permalink?: string };
/** Fired after a Facebook Page connects or disconnects, so every place re-checks it. */
export const FACEBOOK_CHANGED = 'facebook-connection-changed';

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use Facebook.'); }

/** The Page this profile posts to, or null when it isn't connected. */
export async function facebookConnection(profile: string): Promise<FacebookPage | null> { desktopOnly(); return invoke('facebook_connection', { profile }); }
/**
 * One click: opens Meta's approval window (the same Meta app as Instagram), and saves the Page picked there
 * under this profile. pageId and name help pick the brand's Page when several are shared.
 * Rejects with SETUP_NEEDED until the Meta app is saved.
 */
export async function connectFacebookPage(profile: string, pageId?: string, name?: string): Promise<FacebookPage> {
  desktopOnly();
  const page = await invoke<FacebookPage>('connect_facebook_page', { profile, pageId: pageId || null, name: name || null });
  window.dispatchEvent(new CustomEvent(FACEBOOK_CHANGED, { detail: profile }));
  return page;
}
export async function disconnectFacebook(profile: string): Promise<void> {
  desktopOnly();
  await invoke('disconnect_facebook', { profile });
  window.dispatchEvent(new CustomEvent(FACEBOOK_CHANGED, { detail: profile }));
}
/** Uploads a video saved on this PC and publishes it as a Reel on the profile's Page. */
export async function publishFacebookReelFile(path: string, description: string, profile: string): Promise<PublishedReel> {
  desktopOnly();
  return invoke('publish_facebook_reel_file', { path, description, profile });
}
/** Opens a published Reel (a facebook.com /reel/ link) in an app window. */
export async function openFacebookPost(url: string): Promise<void> { desktopOnly(); return invoke('open_facebook_post', { url }); }
