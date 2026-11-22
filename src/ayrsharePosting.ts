import type { AyrsharePost, Platform, UploadedVideo, Video, Workspace } from './model';
import { detailsOf, postText } from './postDetails';
import { NETWORK, type HistoryPost, type PostResponse } from './ayrshareService';

/**
 * What goes to Ayrshare for one video on one social, and how Ayrshare's answers and history become the
 * video's state in the workspace. Ayrshare is the truth: the app keeps each post's id and reads back
 * whether it went up, failed or is still waiting.
 */

const DAY = 86_400_000;

/** Ayrshare's date format: UTC, whole seconds. */
export function ayrshareDate(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The /post body for a video on one social, optionally scheduled. Every AI-made video is labeled where the social can be told. */
export function postBody(video: Video, platform: Platform, mediaUrl: string, scheduleAt?: number): Record<string, unknown> {
  const details = detailsOf(video);
  const ai = details.madeWithAi;
  const cover = details.coverMs != null ? { thumbNailOffset: Math.max(0, Math.round(details.coverMs)) } : {};
  const body: Record<string, unknown> = { post: postText(video, platform), platforms: [NETWORK[platform]], mediaUrls: [mediaUrl], isVideo: true };
  if (scheduleAt !== undefined) {
    body.scheduleDate = ayrshareDate(scheduleAt);
    // Retrying the same slot never posts the same video twice.
    body.idempotencyKey = `${video.id}-${platform}-${Math.floor(scheduleAt / 1000)}`;
  }
  switch (platform) {
    case 'youtube': body.youTubeOptions = { title: (details.youtubeTitle || video.title).slice(0, 100), visibility: 'public', madeForKids: details.madeForKids, shorts: true, containsSyntheticMedia: ai }; break;
    case 'tiktok': body.tikTokOptions = { visibility: 'public', isAIGenerated: ai, ...cover }; break;
    case 'instagram': body.instagramOptions = { shareReelsFeed: details.shareToFeed, isAIGenerated: ai, ...cover }; break;
    case 'facebook': body.faceBookOptions = { reels: true, title: video.title.slice(0, 255) }; break;
    case 'x': body.twitterOptions = { isAIGenerated: ai }; break;
  }
  return body;
}

/** The post for one social out of a /post answer or a history entry. */
function postOf(response: PostResponse): HistoryPost {
  return response.posts?.[0] ?? response;
}
function firstError(post: HistoryPost, platform?: Platform): string | undefined {
  const errors = post.errors ?? [];
  const mine = errors.find((error) => !platform || !error.platform || error.platform === NETWORK[platform]) ?? errors[0];
  return mine?.message;
}
function urlOf(post: HistoryPost, platform: Platform): string | undefined {
  return post.postIds?.find((item) => !item.platform || item.platform === NETWORK[platform])?.postUrl || undefined;
}
/** When a history entry goes (or went) out, in ms. */
export function historyTime(post: HistoryPost): number | undefined {
  const date = post.scheduleDate ?? post.created;
  if (!date) return undefined;
  if (typeof date === 'string') { const ms = Date.parse(date); return Number.isNaN(ms) ? undefined : ms; }
  const seconds = date._seconds ?? date.seconds;
  return typeof seconds === 'number' ? seconds * 1000 : undefined;
}

export type SendResult = { post: AyrsharePost; url?: string };
/** Reads what /post answered for one social. A post that went out right away is posted; one with a date is scheduled. */
export function readPostResponse(response: PostResponse, platform: Platform, at: number): SendResult {
  const post = postOf(response);
  const status = (post.status || response.status || '').toLowerCase();
  const id = post.id || response.id || '';
  const mine = post.postIds?.find((item) => !item.platform || item.platform === NETWORK[platform]);
  if (status === 'scheduled' || status === 'pending') return { post: { id, at, state: 'scheduled' } };
  if (status === 'success' && mine?.status !== 'error') return { post: { id, at, state: 'posted' }, url: urlOf(post, platform) };
  return { post: { id, at, state: 'failed', error: firstError(post, platform) ?? 'Ayrshare did not post it.' } };
}

/** Records a post's new state on a video: posted marks it up (with its link), anything else keeps it waiting. */
export function withPost(video: Video, platform: Platform, result: SendResult): Video {
  const scheduled = { ...video.scheduled, [platform]: result.post };
  if (result.post.state !== 'posted') return { ...video, scheduled };
  return {
    ...video, scheduled,
    posted: video.posted.includes(platform) ? video.posted : [...video.posted, platform],
    postedAt: { ...video.postedAt, [platform]: video.postedAt?.[platform] ?? result.post.at },
    links: result.url ? { ...video.links, [platform]: result.url } : video.links,
  };
}

/** Clears a failed or cancelled post, so the video waits in the queue again. */
export function withoutPost(video: Video, platform: Platform): Video {
  const scheduled = { ...video.scheduled };
  delete scheduled[platform];
  return { ...video, scheduled };
}

/** Whether the uploaded copy of the video is still kept by Ayrshare when a post scheduled at `at` goes out. */
export function mediaUsable(media: UploadedVideo | undefined, source: string, at: number): media is UploadedVideo {
  return !!media?.url && (!media.source || media.source === source) && at < media.at + (media.keepDays - 2) * DAY;
}

/** A scheduled post Ayrshare no longer lists, this long after it was due, is treated as lost. */
const LOST_AFTER = 6 * 3_600_000;

/**
 * Brings a brand's videos in line with Ayrshare's history: posts that went up are marked posted with their
 * link, failed ones show Ayrshare's reason, deleted ones go back to the queue. Returns null when nothing changed.
 */
export function applyHistory(workspace: Workspace, brandId: string, history: HistoryPost[], now = Date.now()): Workspace | null {
  const byId = new Map(history.map((post) => [post.id, post]));
  let changed = false;
  const videos = (workspace.videos ?? []).map((video) => {
    if (video.brandId !== brandId || !video.scheduled) return video;
    let next = video;
    for (const [platform, post] of Object.entries(video.scheduled) as [Platform, AyrsharePost | undefined][]) {
      if (!post || post.state === 'posted') continue;
      const found = byId.get(post.id);
      if (!found) {
        if (post.state === 'scheduled' && post.at < now - LOST_AFTER) { next = withPost(next, platform, { post: { ...post, state: 'failed', error: 'Ayrshare has no record of this post any more. Retry to schedule it again.' } }); changed = true; }
        continue;
      }
      const status = found.status.toLowerCase();
      const entry = found.postIds?.find((item) => !item.platform || item.platform === NETWORK[platform]);
      if (status === 'deleted') { next = withoutPost(next, platform); changed = true; }
      else if (status === 'success' && entry?.status !== 'error') { next = withPost(next, platform, { post: { ...post, state: 'posted', at: Math.min(historyTime(found) ?? post.at, now) }, url: urlOf(found, platform) }); changed = true; }
      else if (status === 'error' || entry?.status === 'error') {
        const error = firstError(found, platform) ?? 'Ayrshare could not post it.';
        if (post.state !== 'failed' || post.error !== error) { next = withPost(next, platform, { post: { ...post, state: 'failed', error } }); changed = true; }
      }
      else if (post.state === 'failed' && (status === 'pending' || status === 'processing')) { next = withPost(next, platform, { post: { ...post, state: 'scheduled', error: undefined } }); changed = true; }
    }
    return next;
  });
  return changed ? { ...workspace, videos } : null;
}

/** Posts of a video still in flight on Ayrshare (scheduled), which a history check can settle. */
export function hasOpenPosts(workspace: Workspace, brandId: string): boolean {
  return (workspace.videos ?? []).some((video) => video.brandId === brandId && Object.values(video.scheduled ?? {}).some((post) => post?.state === 'scheduled'));
}
