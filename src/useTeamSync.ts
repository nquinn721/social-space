import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Workspace } from './model';
import { disableTeamSync, enableTeamSync, teamSyncFetch, teamSyncPush, teamSyncStatus, type TeamStatus } from './teamSyncService';
import { mergeShared, sharedOf } from './workspaceSync';
import { errorText } from './ui';

/** How often the app checks the cloud for the other PC's changes. One tiny read each time. */
export const TEAM_SYNC_POLL_MS = 60_000;
/** A save is uploaded this long after it happens, so a burst of edits goes up once. */
export const TEAM_SYNC_AFTER_SAVE_MS = 3_000;
const MAX_ATTEMPTS = 3;

export type TeamSync = {
  status: TeamStatus | null;
  syncing: boolean;
  error: string;
  syncNow: () => Promise<void>;
  enable: (passphrase: string) => Promise<boolean>;
  disable: () => Promise<void>;
  /** Called after every local save; uploads it shortly after. */
  saved: () => void;
};

type Options = {
  loaded: boolean;
  workspaceRef: MutableRefObject<Workspace>;
  /** Runs work one piece at a time with the app's own saves, so a sync never races a save. */
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /** Saves the merged workspace and shows it. */
  apply: (next: Workspace) => Promise<Workspace>;
};

const accountIds = (workspace: Workspace) => workspace.accounts.map((account) => account.id);

/** One sync: fetch, merge, save locally if anything came in, then upload if anything differs. */
export async function syncOnce({ workspaceRef, apply }: Pick<Options, 'workspaceRef' | 'apply'>): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const local = workspaceRef.current;
    const fetched = await teamSyncFetch(accountIds(local));
    const merged = mergeShared(fetched.base, local, fetched.remote);
    const current = JSON.stringify(merged) === JSON.stringify(local) ? local : await apply(merged);
    const pushed = await teamSyncPush(sharedOf(current), accountIds(current));
    if (!pushed.conflict) return;
  }
  throw new Error('The other PC kept changing things at the same time. It will try again in a minute.');
}

export function useTeamSync({ loaded, workspaceRef, exclusive, apply }: Options): TeamSync {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const later = useRef<number | undefined>(undefined);
  const deps = useRef({ workspaceRef, exclusive, apply });
  deps.current = { workspaceRef, exclusive, apply };

  const refreshStatus = useCallback(async () => { try { setStatus(await teamSyncStatus()); } catch { setStatus(null); } }, []);
  useEffect(() => { if (isTauri()) void refreshStatus(); }, [refreshStatus]);

  const enabled = Boolean(status?.enabled);
  const syncNow = useCallback(async () => {
    if (!enabled || !loaded || running.current) return;
    running.current = true; setSyncing(true);
    try {
      await deps.current.exclusive(() => syncOnce(deps.current));
      setError('');
      await refreshStatus();
    } catch (reason) {
      setError(errorText(reason, 'Could not sync with the cloud.'));
    } finally {
      running.current = false; setSyncing(false);
    }
  }, [enabled, loaded, refreshStatus]);

  useEffect(() => {
    if (!enabled || !loaded) return;
    void syncNow();
    const timer = window.setInterval(() => void syncNow(), TEAM_SYNC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, loaded, syncNow]);

  const saved = useCallback(() => {
    if (!enabled) return;
    window.clearTimeout(later.current);
    later.current = window.setTimeout(() => void syncNow(), TEAM_SYNC_AFTER_SAVE_MS);
  }, [enabled, syncNow]);
  useEffect(() => () => window.clearTimeout(later.current), []);

  const enable = useCallback(async (passphrase: string) => {
    const created = await enableTeamSync(passphrase);
    await refreshStatus();
    return created;
  }, [refreshStatus]);
  const disable = useCallback(async () => { await disableTeamSync(); await refreshStatus(); setError(''); }, [refreshStatus]);

  return { status, syncing, error, syncNow, enable, disable, saved };
}
