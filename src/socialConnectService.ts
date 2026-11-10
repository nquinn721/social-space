import { invoke, isTauri } from '@tauri-apps/api/core';

/** What a profile is connected as on YouTube (channel) or TikTok (account). */
export type SocialConnection = { id: string; username: string; name: string };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to connect.'); }
/** Redirect addresses to add in the Google and TikTok developer apps. */
export const YOUTUBE_REDIRECT_URI = 'http://127.0.0.1:49174/socialspace/youtube';
export const TIKTOK_REDIRECT_URI = 'https://localhost/socialspace/tiktok';
export async function connectYoutube(profile: string, emailHint?: string): Promise<SocialConnection> { desktopOnly(); return invoke('connect_youtube', { profile, emailHint: emailHint || null }); }
export async function youtubeConnection(profile: string): Promise<SocialConnection | null> { desktopOnly(); return invoke('youtube_connection', { profile }); }
export async function disconnectYoutube(profile: string): Promise<void> { desktopOnly(); return invoke('disconnect_youtube', { profile }); }
export async function connectTiktok(profile: string, username?: string): Promise<SocialConnection> { desktopOnly(); return invoke('connect_tiktok', { profile, username: username || null }); }
export async function tiktokConnection(profile: string): Promise<SocialConnection | null> { desktopOnly(); return invoke('tiktok_connection', { profile }); }
export async function disconnectTiktok(profile: string): Promise<void> { desktopOnly(); return invoke('disconnect_tiktok', { profile }); }
