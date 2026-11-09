import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Account, Platform, PlatformAction, Workspace } from './model';

export type FormFields = Partial<Record<'email' | 'phone' | 'username' | 'firstName' | 'lastName' | 'displayName' | 'fullName' | 'bio' | 'website' | 'verificationCode' | 'birthday', string>>;
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use this.'); }
/** Opens a platform page in an app window and returns the window id. */
export async function openPlatformWindow(platform: Platform, action: PlatformAction): Promise<string> { desktopOnly(); return invoke('open_platform_action', { platform, action }); }
export type FillOptions = { imagePath?: string; accountId?: string; includePassword?: boolean; keepFilling?: boolean; replace?: boolean };
/**
 * Pre-fills the visible form in that window. It never submits; the user does.
 * The saved password is looked up in Rust, so it never passes through here.
 * keepFilling also fills later steps and pages of the same sign-up flow.
 * replace overwrites what the page already shows (each field once), for editing an existing profile.
 */
export async function fillSiteForm(windowLabel: string, fields: FormFields, options: FillOptions = {}): Promise<void> {
  desktopOnly();
  return invoke('fill_site_form', { windowLabel, fields, imagePath: options.imagePath || null, accountId: options.accountId ?? null, includePassword: options.includePassword ?? false, keepFilling: options.keepFilling ?? false, replace: options.replace ?? false });
}
export type Bounds = { x: number; y: number; width: number; height: number };
/** Shows a platform page inside the app window, over the given area, and returns its id for filling. */
export async function embedPlatformPage(platform: Platform, action: PlatformAction, bounds: Bounds): Promise<string> { desktopOnly(); return invoke('embed_platform_page', { platform, action, bounds }); }
export async function setEmbeddedBounds(label: string, bounds: Bounds): Promise<void> { desktopOnly(); return invoke('set_embedded_bounds', { label, bounds }); }
/** Opens Google's sign-up in an app window for a new Gmail, and returns the window id for filling. */
export async function openGmailSignup(): Promise<string> { desktopOnly(); return invoke('open_gmail_signup'); }
export async function closeEmbeddedPage(): Promise<void> { if (!isTauri()) return; return invoke('close_embedded_page'); }
export function formFieldsFor(account: Account, verificationCode?: string): FormFields {
  const name = account.displayName || account.label;
  const fields: FormFields = { email: account.signupEmail, username: account.handle, fullName: name, displayName: name, bio: account.bio, website: account.website, birthday: account.birthday, verificationCode };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as FormFields;
}
/** Creates a strong password for the account in Windows Credential Manager if it has none. */
export async function ensureAccountPassword(accountId: string): Promise<void> { desktopOnly(); return invoke('ensure_account_password', { accountId }); }
export async function hasAccountPassword(accountId: string): Promise<boolean> { desktopOnly(); return invoke('has_account_password', { accountId }); }
export async function revealAccountPassword(accountId: string): Promise<string> { desktopOnly(); return invoke('reveal_account_password', { accountId }); }
export async function deleteAccountPassword(accountId: string): Promise<void> { desktopOnly(); return invoke('delete_account_password', { accountId }); }
/** Finds a likely verification code (4 to 8 digits) in an email. */
export function findCode(text: string): string | null {
  const labelled = text.match(/(?:code|pin|otp)[^0-9]{0,40}(\d{4,8})\b/i);
  if (labelled) return labelled[1];
  const bare = text.match(/\b(\d{4,8})\b/);
  return bare ? bare[1] : null;
}
export async function chooseImageFile(): Promise<string | null> { desktopOnly(); return invoke('choose_image_file'); }
export async function loadImagePreview(path: string): Promise<string> { desktopOnly(); return invoke('load_image_preview', { path }); }
export async function setAccountPassword(accountId: string, password: string): Promise<void> { desktopOnly(); return invoke('set_account_password', { accountId, password }); }
/** Gives all these accounts one shared password (reusing one already saved, or a new strong one). */
export async function ensureSharedPassword(accountIds: string[]): Promise<void> { desktopOnly(); return invoke('ensure_shared_password', { accountIds }); }
/** Saves an encrypted file with every username, email and password. Returns its name, or null if cancelled. */
export async function exportSignIns(passphrase: string): Promise<string | null> { desktopOnly(); return invoke('export_sign_ins', { passphrase }); }
export type RestoredSignIns = { workspace: Workspace; passwordsRestored: number; createdAt: number };
/** Restores passwords from a backup file and returns its saved workspace, or null if cancelled. */
export async function importSignIns(passphrase: string): Promise<RestoredSignIns | null> { desktopOnly(); return invoke('import_sign_ins', { passphrase }); }
