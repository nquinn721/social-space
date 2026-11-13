import { useEffect, useRef, useState } from 'react';
import { getPlatform, type Platform, type Video, type Workspace } from './model';
import { detailsOf, formatMs, postText } from './postDetails';
import { withPosted } from './appReviews';
import { onPostingUpdate, openPostingWindow, type PostRequest } from './postingService';

type Save = (next: Workspace, message: string) => Promise<boolean | undefined>;
export type Asking = { videoId: string; platform: Platform };

/** What the upload page of one social gets for one video: the brand's profile there, the file and every detail. */
export function postRequest(workspace: Workspace, video: Video, platform: Platform): PostRequest {
  const account = workspace.accounts.find((item) => item.brandId === video.brandId && item.platform === platform);
  const details = detailsOf(video);
  return {
    platform, brandId: video.brandId, videoId: video.id, accountId: account?.id, handle: account?.handle ?? '', email: account?.signupEmail ?? '',
    videoPath: video.mediaSource, title: details.youtubeTitle || video.title, text: postText(video), madeWithAi: details.madeWithAi,
    madeForKids: details.madeForKids, cover: details.coverMs == null ? '' : formatMs(details.coverMs), coverMs: details.coverMs,
  };
}

/** Marks a video as posted on a social in the latest workspace. */
export function markPosted(workspace: Workspace, videoId: string, platform: Platform): Workspace | null {
  const video = workspace.videos?.find((item) => item.id === videoId);
  if (!video || video.posted.includes(platform)) return null;
  return { ...workspace, videos: (workspace.videos ?? []).map((item) => item.id === videoId ? withPosted(item, [...item.posted, platform], workspace.setup) : item) };
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
