import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Platform } from './model';
import type { FormFields } from './profileService';

/** One video going up on one social through its own upload page, in an app window. */
export type PostRequest = {
  platform: Platform; brandId: string; videoId: string; accountId?: string; handle: string; email: string;
  videoPath: string; title: string; text: string; madeWithAi: boolean; madeForKids: boolean; cover: string; coverMs?: number;
};
/** posted: the page showed the post went up. closed: the window was closed (posted says whether it had). */
export type PostingUpdate = { videoId: string; platform: Platform; state: 'posted' | 'closed'; posted: boolean };

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to post.'); }
export async function openPostingWindow(request: PostRequest): Promise<string> { desktopOnly(); return invoke('open_posting_window', { request }); }
/** Hears about posting windows; returns the function that stops listening. */
export async function onPostingUpdate(handler: (update: PostingUpdate) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  try { return await listen<PostingUpdate>('posting-window', (event) => handler(event.payload)); }
  catch { return () => {}; }
}

/** Opens a brand profile's public page (its live videos): in a Social Space window signed in as the brand, or the default browser. */
export async function openProfilePage(request: { platform: Platform; brandId: string; accountId?: string; handle: string; email: string; inBrowser: boolean; target?: 'profile' | 'settings' }): Promise<void> {
  desktopOnly(); return invoke('open_profile_page', { request });
}

/** Opens the social's forgot-password page in the brand's window, with the profile's email and a new password filled in (not saved yet). */
export async function openPasswordReset(request: { platform: Platform; brandId: string; accountId: string; handle: string; email: string }): Promise<void> {
  desktopOnly(); return invoke('open_password_reset', { request: { ...request, inBrowser: false } });
}
/** Saves the new password of the last reset of this profile, once the social accepted it. */
export async function saveResetPassword(accountId: string): Promise<void> {
  desktopOnly();
  await invoke('save_reset_password', { accountId });
  window.dispatchEvent(new CustomEvent('account-password-saved', { detail: accountId }));
}

/** What a brand profile's editor gets filled with: the profile's own name, bio, website and keywords, and its picture. */
export type ProfileEditRequest = { platform: Platform; brandId: string; accountId?: string; handle: string; email: string; fields: FormFields; imagePath?: string };
/** Opens the profile's editor (picture, name, bio) in a Social Space window signed in as the brand, filled for Nate to check and save. */
export async function openProfileEditor(request: ProfileEditRequest): Promise<string> {
  desktopOnly(); return invoke('open_profile_editor', { request });
}

/** Whether a brand's window folder is signed in to a social on this PC, and as whom (when the page showed it). */
export type BrandSignIn = { signedIn: boolean; handle?: string; checkedAt: number };
/** Brand id → social → its last checked sign-in. */
export type SignIns = Record<string, Partial<Record<Platform, BrandSignIn>>>;
export async function postingSignIns(): Promise<SignIns> { if (!isTauri()) return {}; return invoke('posting_sign_ins'); }
/** Hears when a brand window's sign-in changes; returns the function that stops listening. */
export async function onSignInChange(handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  try { return await listen<string>('posting-sign-in', () => handler()); }
  catch { return () => {}; }
}
