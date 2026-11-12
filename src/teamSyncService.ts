import { invoke, isTauri } from '@tauri-apps/api/core';
import type { SharedWorkspace } from './workspaceSync';

/** Team sync: brands, accounts and saved sign-ins shared with the partner's copy of the app, end-to-end encrypted. */
export type TeamStatus = { reviewConnected: boolean; enabled: boolean; lastSyncedAt: number };
export type TeamFetched = { rev: number; remote: SharedWorkspace | null; base: SharedWorkspace | null; secretsReceived: number };
export type TeamPushed = { rev: number; pushed: boolean; conflict: boolean };

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to share accounts.'); }

export async function teamSyncStatus(): Promise<TeamStatus | null> { if (!isTauri()) return null; return invoke('team_sync_status'); }
/** Returns true when this PC started the team (nothing was shared yet). */
export async function enableTeamSync(passphrase: string): Promise<boolean> { desktopOnly(); return invoke('team_sync_enable', { passphrase }); }
export async function disableTeamSync(): Promise<void> { desktopOnly(); return invoke('team_sync_disable'); }
export async function teamSyncFetch(accountIds: string[]): Promise<TeamFetched> { desktopOnly(); return invoke('team_sync_fetch', { accountIds }); }
export async function teamSyncPush(workspace: SharedWorkspace, accountIds: string[]): Promise<TeamPushed> { desktopOnly(); return invoke('team_sync_push', { workspace, accountIds }); }
