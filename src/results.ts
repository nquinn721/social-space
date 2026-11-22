import type { Platform, Video, Workspace } from './model';

/** Ayrshare's names for our socials, both ways. */
const PLATFORM_OF: Record<string, Platform> = { instagram: 'instagram', facebook: 'facebook', tiktok: 'tiktok', youtube: 'youtube', twitter: 'x', x: 'x' };
const DAY = 86_400_000;

export type Numbers = { views: number; likes: number; comments: number; shares: number };
export const ZERO: Numbers = { views: 0, likes: 0, comments: 0, shares: 0 };
/** Results of one Ayrshare post (one video on one social), read at `at`. */
export type PostResult = Numbers & { at: number };
/** Followers of each linked social of a brand, read at `at`. */
export type SocialResult = { followers: number; at: number };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The first field that holds a number (Ayrshare sends some, like YouTube's subscriberCount, as text). */
function first(source: Json | undefined, ...keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    if (isObject(value) && typeof value.total === 'number') return value.total;
  }
  return undefined;
}

/**
 * Views, likes, comments and shares from Ayrshare's post analytics, whichever names each social uses:
 * TikTok videoViews/likeCount, Instagram viewsCount/playsCount, YouTube views/likes, X publicMetrics,
 * Facebook videoViews/reactions.
 */
export function readPostAnalytics(value: Json): Partial<Record<Platform, Numbers>> {
  const out: Partial<Record<Platform, Numbers>> = {};
  for (const [network, block] of Object.entries(value)) {
    const platform = PLATFORM_OF[network];
    if (!platform || !isObject(block)) continue;
    const analytics = isObject(block.analytics) ? block.analytics : undefined;
    if (!analytics) continue;
    const metrics = isObject(analytics.publicMetrics) ? analytics.publicMetrics : undefined;
    out[platform] = {
      views: first(analytics, 'videoViews', 'viewsCount', 'playsCount', 'views', 'mediaView', 'impressionCount') ?? first(metrics, 'impressionCount') ?? 0,
      likes: first(analytics, 'likeCount', 'likes', 'reactions') ?? first(metrics, 'likeCount') ?? 0,
      comments: first(analytics, 'commentsCount', 'comments', 'commentCount', 'replies') ?? first(metrics, 'replyCount') ?? 0,
      shares: first(analytics, 'sharesCount', 'shareCount', 'shares', 'reposts') ?? first(metrics, 'retweetCount') ?? 0,
    };
  }
  return out;
}

/** Followers of each social from Ayrshare's social analytics (YouTube calls them subscribers, a Facebook Page fans). */
export function readSocialAnalytics(value: Json): Partial<Record<Platform, number>> {
  const out: Partial<Record<Platform, number>> = {};
  for (const [network, block] of Object.entries(value)) {
    const platform = PLATFORM_OF[network];
    if (!platform || !isObject(block) || !isObject(block.analytics)) continue;
    const followers = first(block.analytics, 'followersCount', 'followerCount', 'subscriberCount', 'fanCount');
    if (followers !== undefined) out[platform] = followers;
  }
  return out;
}

/** One comment left on a post, with what's needed to answer it. */
export type Comment = {
  /** The social's own ID, which a reply goes to. */
  id: string;
  platform: Platform;
  brandId: string;
  videoId: string;
  /** The Ayrshare post it's on. */
  postId: string;
  author: string;
  text: string;
  at: number;
  /** TikTok replies need the video's own ID. */
  socialVideoId?: string;
  /** Someone with the brand's own name already replied to it. */
  answered: boolean;
};

const text = (value: unknown) => typeof value === 'string' ? value : '';
function authorOf(item: Json): string {
  const from = isObject(item.from) ? text(item.from.name) : '';
  return text(item.userName) || text(item.username) || text(item.displayName) || from || text(item.name) || 'Someone';
}
function timeOf(item: Json): number {
  const raw = item.created ?? item.createTime;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const parsed = Date.parse(text(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The comments on one Ayrshare post, newest first. A comment counts as answered when one of its replies is
 * from the brand itself (TikTok marks the owner; elsewhere the reply's name is the linked account's).
 */
export function readComments(value: Json, where: { brandId: string; videoId: string; postId: string }, ownNames: Partial<Record<Platform, string>> = {}): Comment[] {
  const out: Comment[] = [];
  for (const [network, list] of Object.entries(value)) {
    const platform = PLATFORM_OF[network];
    if (!platform || !Array.isArray(list)) continue;
    const own = (ownNames[platform] ?? '').replace(/^@/, '').toLowerCase();
    for (const item of list) {
      if (!isObject(item)) continue;
      const id = text(item.commentId) || text(item.id);
      if (!id || item.owner === true) continue;
      const replies = Array.isArray(item.replies) ? item.replies.filter(isObject) : [];
      const answered = replies.some((reply) => reply.owner === true || (own !== '' && authorOf(reply).replace(/^@/, '').toLowerCase() === own));
      out.push({ id, platform, ...where, author: authorOf(item), text: text(item.comment), at: timeOf(item), socialVideoId: text(item.videoId) || undefined, answered });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Each Ayrshare post of a video that is up, with its social and when it went up. */
export function livePosts(video: Video): { platform: Platform; id: string; at: number }[] {
  return video.posted.flatMap((platform) => {
    const post = video.scheduled?.[platform];
    const at = video.postedAt?.[platform] ?? post?.at;
    return post?.id && at !== undefined ? [{ platform, id: post.id, at }] : [];
  });
}

/** Posts that went up since `since`, newest first, at most `limit`: the ones whose results and comments are read. */
export function recentPosts(workspace: Workspace, since: number, limit: number) {
  return (workspace.videos ?? []).flatMap((video) => livePosts(video).filter((post) => post.at >= since).map((post) => ({ video, ...post })))
    .sort((a, b) => b.at - a.at).slice(0, limit);
}

export const sum = (items: Numbers[]): Numbers => items.reduce((total, item) => ({ views: total.views + item.views, likes: total.likes + item.likes, comments: total.comments + item.comments, shares: total.shares + item.shares }), ZERO);

export type Range = 'today' | '7d' | '30d';
export const RANGE_DAYS: Record<Range, number> = { today: 1, '7d': 7, '30d': 30 };

/** Results of the posts that went up in the range, and in the same length of time before it (for the change). */
export function rangeTotals(workspace: Workspace, results: Record<string, PostResult>, range: Range, now: number, brandId?: string) {
  const length = RANGE_DAYS[range] * DAY;
  const posts = (workspace.videos ?? []).filter((video) => !brandId || video.brandId === brandId).flatMap((video) => livePosts(video).map((post) => ({ video, ...post })));
  const within = (from: number, to: number) => sum(posts.filter((post) => post.at >= from && post.at < to).map((post) => results[post.id] ?? ZERO));
  return { current: within(now - length, now + 1), previous: within(now - 2 * length, now - length) };
}

/** Change from the previous period, as a whole percent; null when there is nothing to compare with. */
export function change(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** Views per day over the range, by the day each post went up, oldest day first. */
export function viewsByDay(workspace: Workspace, results: Record<string, PostResult>, days: number, now: number, brandId?: string): { day: number; views: number }[] {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const starts = Array.from({ length: days }, (_, index) => { const day = new Date(today); day.setDate(day.getDate() - (days - 1 - index)); return day.getTime(); });
  const totals = starts.map((day) => ({ day, views: 0 }));
  for (const video of workspace.videos ?? []) {
    if (brandId && video.brandId !== brandId) continue;
    for (const post of livePosts(video)) {
      const index = starts.findIndex((day, at) => post.at >= day && (at === starts.length - 1 || post.at < starts[at + 1]));
      if (index >= 0 && post.at <= now) totals[index].views += results[post.id]?.views ?? 0;
    }
  }
  return totals;
}

/** Views per social over the range. */
export function viewsBySocial(workspace: Workspace, results: Record<string, PostResult>, since: number, brandId?: string): Partial<Record<Platform, Numbers>> {
  const out: Partial<Record<Platform, Numbers>> = {};
  for (const video of workspace.videos ?? []) {
    if (brandId && video.brandId !== brandId) continue;
    for (const post of livePosts(video)) {
      if (post.at < since) continue;
      out[post.platform] = sum([out[post.platform] ?? ZERO, results[post.id] ?? ZERO]);
    }
  }
  return out;
}

/** Videos with their results over every social, best first. */
export function topVideos(workspace: Workspace, results: Record<string, PostResult>, since: number, brandId?: string, limit = 10) {
  return (workspace.videos ?? []).filter((video) => !brandId || video.brandId === brandId)
    .map((video) => { const posts = livePosts(video).filter((post) => post.at >= since); return { video, posts: posts.length, total: sum(posts.map((post) => results[post.id] ?? ZERO)) }; })
    .filter((item) => item.posts > 0).sort((a, b) => b.total.views - a.total.views || b.total.likes - a.total.likes).slice(0, limit);
}

/** Followers gained since the oldest saved count that is at least `days` old (or the oldest there is). */
export function followersGained(history: { day: number; total: number }[], days: number, now: number): number | null {
  if (history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.day - b.day);
  const cutoff = now - days * DAY;
  const base = [...sorted].reverse().find((item) => item.day <= cutoff) ?? sorted[0];
  return sorted[sorted.length - 1].total - base.total;
}

export const compact = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : value >= 10_000 ? `${Math.round(value / 1000)}K` : value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(value);
