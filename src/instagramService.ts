import { invoke, isTauri } from '@tauri-apps/api/core';
/** facebook: a Facebook Page token. instagram: an Instagram-login token (starts with IG). */
export type InstagramLogin = 'facebook' | 'instagram';
export type InstagramIdentity = { id: string; username: string; login?: InstagramLogin };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to connect Instagram.'); }
/** profile: the app profile whose own connection to use; omitted means the older shared one. */
export async function instagramConnection(profile?: string): Promise<InstagramIdentity | null> { desktopOnly(); return invoke('instagram_connection', { profile: profile ?? null }); }
/** That profile's connection, taking over the older shared one when it is the same Instagram username. */
export async function claimInstagramConnection(profile: string, username: string): Promise<InstagramIdentity | null> { desktopOnly(); return invoke('claim_instagram_connection', { profile, username }); }
/** The account ID is only needed for Facebook Page tokens; Instagram tokens identify their account. */
export async function connectInstagram(accountId: string, accessToken: string, profile?: string): Promise<InstagramIdentity> { desktopOnly(); return invoke('connect_instagram', { accountId: accountId || null, accessToken, profile: profile ?? null }); }
export async function disconnectInstagram(profile?: string): Promise<void> { desktopOnly(); return invoke('disconnect_instagram', { profile: profile ?? null }); }
export async function publishInstagramReel(videoUrl: string, caption: string, profile?: string): Promise<{ id: string }> { desktopOnly(); return invoke('publish_instagram_reel', { videoUrl, caption, profile: profile ?? null }); }
export async function publishInstagramPhoto(imageUrl: string, caption: string, profile?: string): Promise<{ id: string }> { desktopOnly(); return invoke('publish_instagram_photo', { imageUrl, caption, profile: profile ?? null }); }
/** coverMs: the moment of the video used as the Reel's cover. shareToFeed: also show it in the main feed. */
export type ReelOptions = { coverMs?: number; shareToFeed?: boolean };
export async function publishInstagramReelFile(path: string, caption: string, profile?: string, options: ReelOptions = {}): Promise<{ id: string }> {
  desktopOnly();
  return invoke('publish_instagram_reel_file', { path, caption, profile: profile ?? null, coverMs: options.coverMs == null ? null : Math.max(0, Math.round(options.coverMs)), shareToFeed: options.shareToFeed ?? null });
}
export async function chooseInstagramVideo(): Promise<string | null> { desktopOnly(); return invoke('choose_instagram_video'); }
/** Whether the one-time Meta app details are saved, so Connect is a single click. */
export async function instagramAppReady(): Promise<boolean> { desktopOnly(); return invoke('instagram_app_ready'); }
/** configId is the Facebook Login for Business configuration that newer (Unified login) Meta apps need. */
export async function saveInstagramApp(appId: string, appSecret: string, configId?: string): Promise<void> { desktopOnly(); return invoke('save_instagram_app', { appId, appSecret, configId: configId || null }); }
/** Address to add under Valid OAuth Redirect URIs in the Meta app. */
export const INSTAGRAM_REDIRECT_URI = 'https://nquinn721.github.io/socialspace/instagram';
/** Opens Instagram's approval window with the profile's saved sign-in filled in. Rejects with SETUP_NEEDED until the Meta app is saved. */
export async function connectInstagramApp(accountId: string | null, username: string | null): Promise<InstagramIdentity> { desktopOnly(); return invoke('connect_instagram_app', { accountId, username }); }
