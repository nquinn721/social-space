import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Workspace } from './model';
import { instagramConnection, publishInstagramReelFile } from './instagramService';

/** The brand's connected Instagram profile, which the library can publish to in one click. */
export type BrandInstagram = { accountId: string; username: string; canUploadFiles: boolean };

/**
 * Finds the brand's live Instagram profile and checks that it is connected through Meta.
 * null while checking, when the brand has none, or when it is not connected yet.
 */
export function useBrandInstagram(workspace: Workspace, brandId: string | undefined): BrandInstagram | null {
  const account = workspace.accounts.find((item) => item.brandId === brandId && item.platform === 'instagram' && item.status === 'active');
  const [connected, setConnected] = useState<BrandInstagram | null>(null);
  useEffect(() => {
    let live = true;
    setConnected(null);
    if (!account || !isTauri()) return;
    instagramConnection(account.id)
      .then((identity) => {
        if (live && identity) setConnected({ accountId: account.id, username: identity.username, canUploadFiles: identity.login !== 'instagram' });
      })
      .catch(() => { /* Not connected: the library keeps its open-in-Instagram button. */ });
    return () => { live = false; };
  }, [account?.id]);
  return connected;
}

/** Uploads a video saved on this PC and publishes it as a Reel on that profile. */
export function publishVideoToInstagram(target: BrandInstagram, path: string, caption: string) {
  return publishInstagramReelFile(path, caption, target.accountId);
}
