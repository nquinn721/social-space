import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Platform, Video, Workspace } from './model';
import { errorText } from './ui';
import { approvedToPost, approvedVideo, finishedStatus, partnerVideo, partnerVideosToImport, resultEvent, REVIEW_POLL_MS, reviewCatalog, submissionFor } from './partnerReview';
import { claimReviewPost, importReviewVideo, listReviewPosts, publishReviewCatalog, recordReviewResult, reviewConnection, submitForReview, type PlatformResult, type ReviewConnection, type ReviewPost } from './reviewService';

type Save = (next: Workspace, message: string) => Promise<boolean | undefined>;
export type PartnerReview = {
  connection: ReviewConnection | null;
  /** Review posts by video id. */
  posts: Record<string, ReviewPost>;
  error: string;
  refresh: () => Promise<void>;
  setConnection: (connection: ReviewConnection | null) => void;
  send: (video: Video, socials: Platform[]) => Promise<void>;
};

const ReviewContext = createContext<PartnerReview | null>(null);
export const usePartnerReviewContext = () => useContext(ReviewContext);
export function PartnerReviewProvider({ value, children }: { value: PartnerReview; children: ReactNode }) {
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

/** Videos already brought in from the review site, so one removed from the library is not brought back. */
const IMPORTED_KEY = 'socialspace.reviewImports';
function importedIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? '[]')); } catch { return new Set(); }
}
function rememberImported(id: string) {
  try { localStorage.setItem(IMPORTED_KEY, JSON.stringify([...importedIds(), id])); } catch { /* only costs a possible re-import */ }
}

/**
 * Keeps the app in step with the review site: loads the posts sent for review, and puts each one the
 * reviewer approved (with the reviewer's edits) into the queue, which schedules it through Ayrshare.
 * Checks every minute while the app is open and partner review is connected.
 */
export function usePartnerReview(workspace: Workspace, loaded: boolean, onSave: Save): PartnerReview {
  const [connection, setConnection] = useState<ReviewConnection | null>(null);
  const [posts, setPosts] = useState<Record<string, ReviewPost>>({});
  const [error, setError] = useState('');
  const latest = useRef(workspace);
  latest.current = workspace;
  // Refs, so the minute timer is not restarted every time the app re-renders.
  const save = useRef(onSave);
  save.current = onSave;
  const ready = useRef(loaded);
  ready.current = loaded;
  const working = useRef(false);

  useEffect(() => { if (isTauri()) reviewConnection().then(setConnection).catch(() => setConnection(null)); }, []);

  const postApproved = useCallback(async (approved: ReviewPost[]) => {
    for (const post of approved) {
      const video = (latest.current.videos ?? []).find((item) => item.id === post.videoId);
      const events = [...(post.events ?? [])];
      // The video file lives on the PC that sent it, so another PC sharing this team leaves it alone.
      if (!video?.mediaSource) continue;
      // Both PCs watch the site: only the one that claims the post first publishes it.
      if (!await claimReviewPost(post.videoId)) continue;
      const toPost = approvedVideo(video, post);
      const results: Partial<Record<Platform, PlatformResult>> = { ...post.results };
      for (const platform of post.platforms ?? []) {
        if (results[platform]?.status === 'posted') continue;
        const result: PlatformResult = { status: 'manual', at: Date.now() };
        results[platform] = result;
        events.push(resultEvent(platform, result));
      }
      await recordReviewResult(post.videoId, finishedStatus(post.platforms ?? [], results), results, events);
      const now = latest.current;
      if ((now.videos ?? []).some((item) => item.id === video.id)) {
        await save.current({ ...now, videos: (now.videos ?? []).map((item) => item.id === video.id ? { ...toPost, posted: item.posted, postedAt: item.postedAt, scheduled: item.scheduled, links: item.links } : item) }, `"${video.title}" was approved and is in the queue.`);
      }
    }
  }, []);

  /** Brings videos the reviewer made on the site into their brand's category, one save for all of them. */
  const importPartnerVideos = useCallback(async (list: ReviewPost[]) => {
    const done = importedIds();
    const fresh = partnerVideosToImport(list, latest.current).filter((post) => !done.has(post.videoId));
    const added: Video[] = [];
    for (const post of fresh) {
      try {
        const path = await importReviewVideo(post.mediaPath!, post.brand, post.category, post.title);
        added.push(partnerVideo(post, path));
        rememberImported(post.videoId);
      } catch (reason) {
        setError(errorText(reason, `Could not bring in "${post.title}" from the review site.`));
      }
    }
    if (!added.length) return;
    const now = latest.current;
    const names = added.map((video) => `"${video.title}"`).join(', ');
    await save.current({ ...now, videos: [...(now.videos ?? []), ...added] }, `Added ${names} from the review site.`);
  }, []);

  const refresh = useCallback(async () => {
    if (!connection || working.current) return;
    working.current = true;
    try {
      const list = await listReviewPosts();
      setPosts(Object.fromEntries(list.map((post) => [post.videoId || post.id, post])));
      setError('');
      if (ready.current) await importPartnerVideos(list);
      const approved = approvedToPost(list);
      if (approved.length && ready.current) {
        await postApproved(approved);
        const after = await listReviewPosts();
        setPosts(Object.fromEntries(after.map((post) => [post.videoId || post.id, post])));
      }
    } catch (reason) {
      setError(errorText(reason, 'Could not reach the review site.'));
    } finally {
      working.current = false;
    }
  }, [connection, importPartnerVideos, postApproved]);

  useEffect(() => {
    if (!connection) { setPosts({}); return; }
    void refresh();
    const timer = window.setInterval(() => void refresh(), REVIEW_POLL_MS);
    return () => window.clearInterval(timer);
  }, [connection, refresh]);

  // Keeps the brands and categories on the site in step with the app, so new videos land in the right place.
  const catalog = loaded && connection ? JSON.stringify(reviewCatalog(workspace)) : '';
  const published = useRef('');
  useEffect(() => {
    if (!catalog || catalog === published.current) return;
    published.current = catalog;
    publishReviewCatalog(JSON.parse(catalog)).catch((reason) => { published.current = ''; setError(errorText(reason, 'Could not update the brands on the review site.')); });
  }, [catalog]);

  const send = useCallback(async (video: Video, socials: Platform[]) => {
    const saved = await submitForReview(submissionFor(video, latest.current, socials));
    setPosts((current) => ({ ...current, [video.id]: saved }));
  }, []);

  return { connection, posts, error, refresh, setConnection, send };
}
