import { invoke, isTauri } from '@tauri-apps/api/core';
export type InstagramIdentity = { id: string; username: string };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to connect Instagram.'); }
export async function instagramConnection(): Promise<InstagramIdentity | null> { desktopOnly(); return invoke('instagram_connection'); }
export async function connectInstagram(accountId: string, accessToken: string): Promise<InstagramIdentity> { desktopOnly(); return invoke('connect_instagram', { accountId, accessToken }); }
export async function disconnectInstagram(): Promise<void> { desktopOnly(); return invoke('disconnect_instagram'); }
export async function publishInstagramReel(videoUrl: string, caption: string): Promise<{ id: string }> { desktopOnly(); return invoke('publish_instagram_reel', { videoUrl, caption }); }
