import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Account, Platform } from './model';
import type { FormFields } from './profileService';
import { sharesLogins } from './brands';

/**
 * Brand windows: Social Space windows with one sign-in folder per brand, so each brand stays signed in to
 * its own accounts. They open a profile's page, its editor and its password reset (and Ayrshare's linking page).
 */
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app for this.'); }

/** The main Gmail: never a brand profile's login. */
export const MAIN_EMAIL = 'softwings25@gmail.com';
/** Whether a profile is saved with the main Gmail as its login, so its sign-in must not be filled. */
export function usesMainLogin(account: Account | undefined): boolean {
  return !!account?.signupEmail && account.signupEmail.trim().toLowerCase() === MAIN_EMAIL;
}
/**
 * An Instagram, Facebook, TikTok or X profile saved with the main Gmail is not the brand's own standalone
 * account. Only YouTube channels rightly sit under a Google account.
 */
export function wrongLogin(account: Account | undefined): boolean {
  return !!account && !sharesLogins(account.platform) && usesMainLogin(account);
}
/** The login a brand window fills for a profile: the brand's own login, never the main Gmail. */
export function brandLogin(account: Account | undefined): { accountId?: string; email: string } {
  if (!account || wrongLogin(account)) return { accountId: undefined, email: '' };
  return { accountId: account.id, email: account.signupEmail ?? '' };
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
