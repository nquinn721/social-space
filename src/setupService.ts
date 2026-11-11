import { useCallback, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listDeveloperApps, type DevProvider } from './devAppsService';
import { hasAccountPassword } from './profileService';
import { canConnect, profileConnection } from './profileConnections';
import type { Account } from './model';
import type { ConnectionCheck, SetupPage } from './setupNeeds';

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to check setup.'); }

/** Opens a developer or account page from the setup tracker in an app window. */
export async function openSetupPage(page: SetupPage): Promise<void> { desktopOnly(); return invoke('open_setup_page', { page }); }

const CHECK_COMMAND = { instagram: 'check_instagram_connection', x: 'check_x_connection', youtube: 'check_youtube_connection', tiktok: 'check_tiktok_connection' } as const;

/**
 * Whether this profile's connection still works. The check renews the connection when it is about to
 * run out, so a post never finds it expired. Older connections are moved onto the profile first.
 */
export async function checkConnection(account: Account): Promise<ConnectionCheck> {
  if (!canConnect(account)) return { state: 'none', username: '', detail: '' };
  if (account.platform !== 'instagram') {
    // Claims a connection made before per-profile connections (X), so the check finds it.
    const identity = await profileConnection(account).catch(() => null);
    if (!identity) return { state: 'none', username: '', detail: '' };
    return invoke<ConnectionCheck>(CHECK_COMMAND[account.platform], { profile: account.id })
      .catch(() => ({ state: 'ok' as const, username: identity, detail: '' }));
  }
  try { return await invoke<ConnectionCheck>(CHECK_COMMAND.instagram, { profile: account.id }); }
  catch {
    const identity = await profileConnection(account).catch(() => null);
    return identity ? { state: 'ok', username: identity, detail: 'Connected.' } : { state: 'none', username: '', detail: '' };
  }
}

/** Loads what the setup tracker can see by itself: developer apps, saved sign-ins and connections. */
export function useSetupStatus(accounts: Account[], refreshKey = 0) {
  const [apps, setApps] = useState<Partial<Record<DevProvider, string | null>> | undefined>(undefined);
  const [connections, setConnections] = useState<Record<string, ConnectionCheck | undefined>>({});
  const [passwords, setPasswords] = useState<Record<string, boolean | undefined>>({});
  const [tick, setTick] = useState(0);
  const ids = accounts.map((account) => `${account.id}:${account.platform}:${account.status}:${account.handle}`).join('|');
  useEffect(() => {
    let live = true;
    const active = accounts.filter((account) => account.status === 'active');
    listDeveloperApps().then((list) => { if (live) setApps(Object.fromEntries(list.map((item) => [item.provider, item.id]))); }).catch(() => { if (live) setApps({}); });
    setConnections({});
    setPasswords({});
    for (const account of active) {
      checkConnection(account).then((check) => { if (live) setConnections((current) => ({ ...current, [account.id]: check })); })
        .catch(() => { if (live) setConnections((current) => ({ ...current, [account.id]: { state: 'unchecked', username: '', detail: 'Could not check this connection.' } })); });
      hasAccountPassword(account.id).then((saved) => { if (live) setPasswords((current) => ({ ...current, [account.id]: saved })); })
        .catch(() => { if (live) setPasswords((current) => ({ ...current, [account.id]: false })); });
    }
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, refreshKey, tick]);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { apps, connections, passwords, refresh };
}
