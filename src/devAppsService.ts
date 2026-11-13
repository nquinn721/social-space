import { invoke, isTauri } from '@tauri-apps/api/core';

/** The one developer app per social that profiles connect through, set up once. */
export type DevProvider = 'meta' | 'x' | 'tiktok' | 'google';
/** productionId: production keys saved ahead while the app still runs on its test keys. */
export type DevAppSummary = { provider: DevProvider; id: string | null; productionId?: string | null };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to set up developer apps.'); }
export async function listDeveloperApps(): Promise<DevAppSummary[]> { desktopOnly(); return invoke('developer_apps'); }
export async function saveDeveloperApp(provider: DevProvider, id: string, secret: string): Promise<void> { desktopOnly(); return invoke('save_developer_app', { provider, id, secret: secret || null }); }
export async function removeDeveloperApp(provider: DevProvider): Promise<void> { desktopOnly(); return invoke('remove_developer_app', { provider }); }
/** Saves production keys ahead, without using them yet. */
export async function saveProductionApp(provider: DevProvider, id: string, secret: string): Promise<void> { desktopOnly(); return invoke('save_production_app', { provider, id, secret: secret || null }); }
/** Puts the production keys saved ahead in use, replacing the test keys. */
export async function switchToProductionApp(provider: DevProvider): Promise<void> { desktopOnly(); return invoke('use_production_app', { provider }); }
