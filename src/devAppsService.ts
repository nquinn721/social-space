import { invoke, isTauri } from '@tauri-apps/api/core';

/** The one developer app per social that profiles connect through, set up once. */
export type DevProvider = 'meta' | 'x' | 'tiktok' | 'google';
export type DevAppSummary = { provider: DevProvider; id: string | null };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to set up developer apps.'); }
export async function listDeveloperApps(): Promise<DevAppSummary[]> { desktopOnly(); return invoke('developer_apps'); }
export async function saveDeveloperApp(provider: DevProvider, id: string, secret: string): Promise<void> { desktopOnly(); return invoke('save_developer_app', { provider, id, secret: secret || null }); }
export async function removeDeveloperApp(provider: DevProvider): Promise<void> { desktopOnly(); return invoke('remove_developer_app', { provider }); }
