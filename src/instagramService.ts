import { invoke, isTauri } from '@tauri-apps/api/core';
/** facebook: a Facebook Page token. instagram: an Instagram-login token (starts with IG). */
export type InstagramLogin = 'facebook' | 'instagram';
export type InstagramIdentity = { id: string; username: string; login?: InstagramLogin };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to connect Instagram.'); }
export async function instagramConnection(): Promise<InstagramIdentity | null> { desktopOnly(); return invoke('instagram_connection'); }
/** The account ID is only needed for Facebook Page tokens; Instagram tokens identify their account. */
export async function connectInstagram(accountId: string, accessToken: string): Promise<InstagramIdentity> { desktopOnly(); return invoke('connect_instagram', { accountId: accountId || null, accessToken }); }
export async function disconnectInstagram(): Promise<void> { desktopOnly(); return invoke('disconnect_instagram'); }
export async function publishInstagramReel(videoUrl: string, caption: string): Promise<{ id: string }> { desktopOnly(); return invoke('publish_instagram_reel', { videoUrl, caption }); }
export async function publishInstagramPhoto(imageUrl: string, caption: string): Promise<{ id: string }> { desktopOnly(); return invoke('publish_instagram_photo', { imageUrl, caption }); }
export async function publishInstagramReelFile(path: string, caption: string): Promise<{ id: string }> { desktopOnly(); return invoke('publish_instagram_reel_file', { path, caption }); }
export async function chooseInstagramVideo(): Promise<string | null> { desktopOnly(); return invoke('choose_instagram_video'); }
