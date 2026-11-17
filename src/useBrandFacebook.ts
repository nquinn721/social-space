import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Video, Workspace } from './model';
import { FACEBOOK_CHANGED, facebookConnection, publishFacebookReelFile } from './facebookService';
import { postText } from './postDetails';

/**
 * The brand's live Facebook profile (its Page) and whether the app can post Reels to it.
 * connected: a Page is connected (null while checking). page: the connected Page's name.
 */
export type BrandFacebook = { accountId: string; page: string; pageId?: string; connected: boolean | null };

/** Finds the brand's live Facebook profile and checks its Page connection. null when the brand has none. */
export function useBrandFacebook(workspace: Workspace, brandId: string | undefined): BrandFacebook | null {
  const account = workspace.accounts.find((item) => item.brandId === brandId && item.platform === 'facebook' && item.status === 'active');
  const [state, setState] = useState<BrandFacebook | null>(null);
  // Connect and Disconnect anywhere in the app re-check it, so every place shows the same state.
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    const again = () => setChecked((value) => value + 1);
    window.addEventListener(FACEBOOK_CHANGED, again);
    return () => window.removeEventListener(FACEBOOK_CHANGED, again);
  }, []);
  useEffect(() => {
    let live = true;
    if (!account) { setState(null); return; }
    const base = { accountId: account.id, page: '' };
    setState({ ...base, connected: null });
    if (!isTauri()) { setState({ ...base, connected: false }); return; }
    facebookConnection(account.id)
      .then((page) => { if (live) setState(page ? { ...base, page: page.name, pageId: page.id, connected: true } : { ...base, connected: false }); })
      .catch(() => { if (live) setState({ ...base, connected: false }); });
    return () => { live = false; };
  }, [account?.id, checked]);
  return state;
}

/** Uploads a video saved on this PC and publishes it as a Reel on the brand's Page, with its description and hashtags. */
export function publishVideoToFacebook(target: BrandFacebook, video: Video) {
  return publishFacebookReelFile(video.mediaSource, postText(video), target.accountId, target.pageId);
}
