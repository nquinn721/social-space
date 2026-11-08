import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Platform, PlatformAction } from './model';

export type FormFields = Partial<Record<'email' | 'phone' | 'username' | 'firstName' | 'lastName' | 'displayName' | 'fullName' | 'bio' | 'website' | 'verificationCode', string>>;
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use this.'); }
/** Opens a platform page in an app window and returns the window id. */
export async function openPlatformWindow(platform: Platform, action: PlatformAction): Promise<string> { desktopOnly(); return invoke('open_platform_action', { platform, action }); }
/** Pre-fills the visible form in that window. It never submits; the user does. */
export async function fillSiteForm(windowLabel: string, fields: FormFields, imagePath?: string): Promise<void> { desktopOnly(); return invoke('fill_site_form', { windowLabel, fields, imagePath: imagePath || null }); }
export async function chooseImageFile(): Promise<string | null> { desktopOnly(); return invoke('choose_image_file'); }
export async function loadImagePreview(path: string): Promise<string> { desktopOnly(); return invoke('load_image_preview', { path }); }
