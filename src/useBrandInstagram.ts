import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { normalizeHandle, type Video, type Workspace } from './model';
import { claimInstagramConnection, publishInstagramReelFile } from './instagramService';
import { detailsOf, postText } from './postDetails';

/** Fired after an Instagram profile connects or disconnects. */
export const INSTAGRAM_CHANGED = 'instagram-connection-changed';

/**
 * The brand's live Instagram profile and whether the app can publish to it.
 * connected: signed in through Meta (null while checking). canUploadFiles: that sign-in may upload a video from this PC.
 */
export type BrandInstagram = { accountId: string; handle: string; username: string; providerId?: string; connected: boolean | null; canUploadFiles: boolean };

/**
 * Finds the brand's live Instagram profile and checks its connection. A connection saved before
 * profiles had their own is taken over when it is the same username. null when the brand has no live profile.
 */
export function useBrandInstagram(workspace: Workspace, brandId: string | undefined): BrandInstagram | null {
  const account = workspace.accounts.find((item) => item.brandId === brandId && item.platform === 'instagram' && item.status === 'active');
  const handle = account ? normalizeHandle(account.handle) : '';
  const [state, setState] = useState<BrandInstagram | null>(null);
  // Connect and Disconnect anywhere in the app re-check it, so every place shows the same state.
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    const again = () => setChecked((value) => value + 1);
    window.addEventListener(INSTAGRAM_CHANGED, again);
    return () => window.removeEventListener(INSTAGRAM_CHANGED, again);
  }, []);
  useEffect(() => {
    let live = true;
    if (!account) { setState(null); return; }
    const base = { accountId: account.id, handle, username: handle, canUploadFiles: false };
    setState({ ...base, connected: null });
    if (!isTauri()) { setState({ ...base, connected: false }); return; }
    claimInstagramConnection(account.id, handle)
      .then((identity) => { if (live) setState(identity ? { ...base, username: identity.username, providerId: identity.id, connected: true, canUploadFiles: identity.login !== 'instagram' } : { ...base, connected: false }); })
      .catch(() => { if (live) setState({ ...base, connected: false }); });
    return () => { live = false; };
  }, [account?.id, handle, checked]);
  return state;
}

/** Uploads a video saved on this PC and publishes it as a Reel with its description, hashtags, cover and feed choice. */
export function publishVideoToInstagram(target: BrandInstagram, video: Video) {
  const details = detailsOf(video);
  return publishInstagramReelFile(video.mediaSource, postText(video, undefined, true), target.accountId, { coverMs: details.coverMs, shareToFeed: details.shareToFeed, expectedId: target.providerId });
}
