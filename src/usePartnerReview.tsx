import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { normalizeHandle, type Platform, type Video, type Workspace } from './model';
import { claimInstagramConnection } from './instagramService';
import { publishVideoToInstagram } from './useBrandInstagram';
import { errorText } from './ui';
import { approvedToPost, approvedVideo, AUTO_POST_PLATFORMS, finishedStatus, partnerVideo, partnerVideosToImport, resultEvent, REVIEW_POLL_MS, reviewCatalog, submissionFor } from './partnerReview';
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

/** Posts one approved video to a social. Only Instagram is posted by the app; the others are left to do by hand. */
async function postTo(platform: Platform, video: Video, workspace: Workspace): Promise<PlatformResult> {
  const at = Date.now();
  if (!AUTO_POST_PLATFORMS.includes(platform)) return { status: 'manual', at };
  const account = workspace.accounts.find((item) => item.brandId === video.brandId && item.platform === 'instagram' && item.status === 'active');
  if (!account) return { status: 'failed', error: 'The brand has no live Instagram profile in Social Space.', at };
  try {
    const identity = await claimInstagramConnection(account.id, normalizeHandle(account.handle));
    if (!identity) return { status: 'failed', error: 'Instagram is not connected for this brand.', at };
    if (identity.login === 'instagram') return { status: 'failed', error: 'This Instagram sign-in cannot upload videos from the PC. Connect it through Facebook.', at };
    const handle = normalizeHandle(account.handle);
    const published = await publishVideoToInstagram({ accountId: account.id, handle, username: identity.username, connected: true, canUploadFiles: true }, video);
    return { status: 'posted', url: published.permalink, at: Date.now() };
  } catch (reason) {
    return { status: 'failed', error: errorText(reason, 'Instagram did not publish this video.'), at: Date.now() };
  }
}

/**
 * Keeps the app in step with the review site: loads the posts sent for review, and posts each one the
 * reviewer approved, then saves where it went (on the video and on the review site's history).
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
      if (!video) continue;
      // Both PCs watch the site: only the one that claims the post first publishes it.
      if (!await claimReviewPost(post.videoId)) continue;
      const toPost = approvedVideo(video, post);
      const results: Partial<Record<Platform, PlatformResult>> = { ...post.results };
      for (const platform of post.platforms ?? []) {
        if (results[platform]?.status === 'posted') continue;
        const result = await postTo(platform, toPost, latest.current);
        results[platform] = result;
        events.push(resultEvent(platform, result));
      }
      const status = finishedStatus(post.platforms ?? [], results);
      await recordReviewResult(post.videoId, status, results, events);
      const autoPosted = (Object.entries(results) as [Platform, PlatformResult][]).filter(([, result]) => result.status === 'posted').map(([platform]) => platform);
      const now = latest.current;
      const current = (now.videos ?? []).find((item) => item.id === video.id);
      if (current && autoPosted.length) {
        const links = { ...current.links };
        for (const platform of autoPosted) if (results[platform]?.url) links[platform] = results[platform]!.url;
        const posted = [...new Set([...current.posted, ...autoPosted])];
        await save.current({ ...now, videos: (now.videos ?? []).map((item) => item.id === video.id ? { ...toPost, posted, links } : item) }, `"${video.title}" was approved and posted.`);
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
