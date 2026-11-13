import { useEffect, useRef, useState } from 'react';
import { getPlatform, type Platform, type Video, type Workspace } from './model';
import { detailsOf, formatMs, postText } from './postDetails';
import { onPostingUpdate, openPostingWindow, type PostRequest } from './postingService';
import type { Account } from './model';
import { sharesLogins } from './brands';

/** The main Gmail and the developer-account emails: never a brand profile's login. */
export const MAIN_EMAIL = 'softwings25@gmail.com';
export function mainEmails(developerLogins: Workspace['developerLogins']): Set<string> {
  return new Set([MAIN_EMAIL, ...Object.values(developerLogins ?? {}).map((login) => login.email)].map((email) => email.trim().toLowerCase()).filter(Boolean));
}
/** Whether a profile is saved with the main Gmail as its login, so its sign-in must not be filled. */
export function usesMainLogin(developerLogins: Workspace['developerLogins'], account: Account | undefined): boolean {
  return !!account?.signupEmail && mainEmails(developerLogins).has(account.signupEmail.trim().toLowerCase());
}
/**
 * A TikTok or X profile saved with the main Gmail is not the brand's own account, so nothing posts through it.
 * Instagram and YouTube profiles can rightly sit under the main login (shared login, Google account
 * holding the channels): they post, but their windows are never filled with the main Gmail either.
 */
export function wrongLogin(developerLogins: Workspace['developerLogins'], account: Account | undefined): boolean {
  return !!account && !sharesLogins(account.platform) && usesMainLogin(developerLogins, account);
}
/** The login a window may fill for a profile: its own email and password, never the main Gmail's. */
export function brandLogin(developerLogins: Workspace['developerLogins'], account: Account | undefined): { accountId?: string; email: string } {
  if (!account || usesMainLogin(developerLogins, account)) return { accountId: undefined, email: '' };
  return { accountId: account.id, email: account.signupEmail ?? '' };
}

type Save = (next: Workspace, message: string) => Promise<boolean | undefined>;
export type Asking = { videoId: string; platform: Platform };

/** What the upload page of one social gets for one video: the brand's profile there, the file and every detail. */
export function postRequest(workspace: Workspace, video: Video, platform: Platform): PostRequest {
  const account = workspace.accounts.find((item) => item.brandId === video.brandId && item.platform === platform);
  const details = detailsOf(video);
  return {
    platform, brandId: video.brandId, videoId: video.id, ...brandLogin(workspace.developerLogins, account), handle: account?.handle ?? '',
    videoPath: video.mediaSource, title: details.youtubeTitle || video.title, text: postText(video), madeWithAi: details.madeWithAi,
    madeForKids: details.madeForKids, cover: details.coverMs == null ? '' : formatMs(details.coverMs), coverMs: details.coverMs,
  };
}

/** Marks a video as posted on a social in the latest workspace. */
export function markPosted(workspace: Workspace, videoId: string, platform: Platform): Workspace | null {
  const video = workspace.videos?.find((item) => item.id === videoId);
  if (!video || video.posted.includes(platform)) return null;
  // A post made on the social's own page is a real, public post even while the app's API is in test
  // mode (TikTok Sandbox, YouTube Testing only limit API uploads), so it is never kept as a test post.
  return { ...workspace, videos: (workspace.videos ?? []).map((item) => item.id === videoId ? { ...item, posted: [...item.posted, platform] } : item) };
}

/**
 * Posting through a social's own upload page: opens the window, marks the video posted when the page
 * shows it went up, and otherwise asks when the window is closed.
 */
export function useBrowserPosting(workspace: Workspace, onSave: Save) {
  const latest = useRef(workspace);
  latest.current = workspace;
  const save = useRef(onSave);
  save.current = onSave;
  const [asking, setAsking] = useState<Asking[]>([]);
  const [open, setOpen] = useState<Asking[]>([]);
  const same = (a: Asking) => (b: Asking) => a.videoId === b.videoId && a.platform === b.platform;

  async function confirm(item: Asking, posted: boolean) {
    setAsking((list) => list.filter((other) => !same(item)(other)));
    if (!posted) return;
    const next = markPosted(latest.current, item.videoId, item.platform);
    const video = latest.current.videos?.find((v) => v.id === item.videoId);
    if (next) await save.current(next, `Marked "${video?.title ?? 'the video'}" as posted on ${getPlatform(item.platform).name}.`);
  }

  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void onPostingUpdate((update) => {
      const item = { videoId: update.videoId, platform: update.platform };
      if (update.state === 'closed') setOpen((list) => list.filter((other) => !same(item)(other)));
      if (update.posted) {
        if (update.state === 'posted') void confirm(item, true);
        return;
      }
      const video = latest.current.videos?.find((v) => v.id === update.videoId);
      if (video && !video.posted.includes(update.platform)) setAsking((list) => list.some(same(item)) ? list : [...list, item]);
    }).then((unlisten) => { if (live) stop = unlisten; else unlisten(); });
    return () => { live = false; stop?.(); };
  }, []);

  async function post(video: Video, platform: Platform) {
    const item = { videoId: video.id, platform };
    setAsking((list) => list.filter((other) => !same(item)(other)));
    await openPostingWindow(postRequest(latest.current, video, platform));
    setOpen((list) => list.some(same(item)) ? list : [...list, item]);
  }
  const isAsking = (videoId: string, platform: Platform) => asking.some(same({ videoId, platform }));
  const isOpen = (videoId: string, platform: Platform) => open.some(same({ videoId, platform }));
  return { post, confirm, isAsking, isOpen, asking };
}
