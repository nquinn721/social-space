import { useCallback, useEffect, useState } from 'react';
import { claimInstagramConnection, connectInstagramApp } from './instagramService';
import { claimXConnection, connectX, disconnectX } from './xService';
import { connectTiktok, connectYoutube, disconnectTiktok, disconnectYoutube, tiktokConnection, youtubeConnection } from './socialConnectService';
import { disconnectInstagram } from './instagramService';
import { normalizeHandle, type Account, type Platform } from './model';

/** Socials whose profiles can connect for posting today. */
export const CONNECTABLE: Platform[] = ['instagram', 'x', 'youtube', 'tiktok'];
export const canConnect = (account: Account) => account.status === 'active' && CONNECTABLE.includes(account.platform);
/** Which developer app each social signs in through. */
export const PROVIDER_OF: Record<Platform, 'meta' | 'x' | 'tiktok' | 'google'> = { instagram: 'meta', x: 'x', tiktok: 'tiktok', youtube: 'google' };

/** The username this profile's own connection is signed in as, or null when it has none. */
export async function profileConnection(account: Account): Promise<string | null> {
  if (!canConnect(account)) return null;
  const identity = account.platform === 'instagram' ? await claimInstagramConnection(account.id, normalizeHandle(account.handle))
    : account.platform === 'x' ? await claimXConnection(account.id, normalizeHandle(account.handle))
    : account.platform === 'youtube' ? await youtubeConnection(account.id)
    : await tiktokConnection(account.id);
  if (!identity) return null;
  // A YouTube channel may have no @handle yet; its title still shows it is connected.
  return identity.username || ('name' in identity ? identity.name : '') || 'connected';
}

/**
 * One click: opens the social's approval window for this profile (its saved sign-in filled in where the
 * social allows) and saves the connection under the profile. Rejects with SETUP_NEEDED until that
 * social's developer app is saved.
 */
export async function connectProfile(account: Account): Promise<string> {
  if (account.platform === 'instagram') return (await connectInstagramApp(account.id, normalizeHandle(account.handle))).username;
  if (account.platform === 'x') return (await connectX('', account.id)).username;
  if (account.platform === 'youtube') { const channel = await connectYoutube(account.id, account.signupEmail); return channel.username || channel.name; }
  const tiktok = await connectTiktok(account.id, normalizeHandle(account.handle));
  return tiktok.username || tiktok.name;
}

/** Removes only this profile's connection; nothing changes on the social. */
export async function disconnectProfile(account: Account): Promise<void> {
  if (account.platform === 'instagram') return disconnectInstagram(account.id);
  if (account.platform === 'x') return disconnectX(account.id);
  if (account.platform === 'youtube') return disconnectYoutube(account.id);
  return disconnectTiktok(account.id);
}

/** Connection of every connectable live profile, keyed by profile id. */
export function useProfileConnections(accounts: Account[]) {
  const [connected, setConnected] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const ids = accounts.filter(canConnect).map((account) => `${account.id}:${account.handle}`).join('|');
  const refresh = useCallback(async () => {
    setLoading(true);
    const entries = await Promise.all(accounts.filter(canConnect).map(async (account) => [account.id, await profileConnection(account).catch(() => null)] as const));
    setConnected(Object.fromEntries(entries));
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { connected, loading, refresh };
}
