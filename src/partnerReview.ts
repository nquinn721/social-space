import type { Platform, Video, Workspace } from './model';
import { getPlatform, PLATFORMS } from './model';
import { detailsOf } from './postDetails';
import type { CatalogBrand, PlatformResult, ReviewEvent, ReviewPost, ReviewStatus, ReviewSubmission } from './reviewService';

/** Socials this app posts to by itself once a post is approved; the rest are posted by hand. */
export const AUTO_POST_PLATFORMS: Platform[] = ['instagram'];
/** How often the app checks the review site for decisions. */
export const REVIEW_POLL_MS = 60_000;

/** The post as the reviewer sees it: the video's file, text and where it goes. */
export function submissionFor(video: Video, workspace: Workspace, socials: Platform[]): ReviewSubmission {
  const details = detailsOf(video);
  return {
    videoId: video.id,
    title: video.title,
    brand: workspace.brands.find((brand) => brand.id === video.brandId)?.name ?? '',
    category: workspace.categories?.find((category) => category.id === video.categoryId)?.name ?? '',
    youtubeTitle: details.youtubeTitle,
    description: video.caption.trim(),
    hashtags: details.hashtags,
    platforms: socials.filter((platform) => !video.posted.includes(platform)),
    madeWithAi: details.madeWithAi,
    coverMs: details.coverMs ?? null,
    mediaSource: video.mediaSource,
  };
}

/** The video as approved: the reviewer saw the submitted text, so that is what goes out. */
export function approvedVideo(video: Video, post: ReviewPost): Video {
  return { ...video, caption: post.description, details: { ...detailsOf(video), hashtags: post.hashtags ?? [], youtubeTitle: post.youtubeTitle || detailsOf(video).youtubeTitle } };
}

/** The post's overall status once every social has a result. */
export function finishedStatus(platforms: Platform[], results: Partial<Record<Platform, PlatformResult>>): ReviewStatus {
  const outcomes = platforms.map((platform) => results[platform]?.status);
  if (outcomes.every((outcome) => outcome === 'posted' || outcome === 'manual')) return 'posted';
  if (outcomes.some((outcome) => outcome === 'posted')) return 'partly_posted';
  return 'failed';
}

/** One line for the history on the review site. */
export function resultEvent(platform: Platform, result: PlatformResult): ReviewEvent {
  const name = getPlatform(platform).name;
  const text = result.status === 'posted' ? `Posted to ${name}` : result.status === 'manual' ? `${name} is posted by hand from Social Space` : `${name} failed: ${result.error ?? 'unknown error'}`;
  return { at: result.at, text };
}

/** Approved posts that still have to be posted, oldest decision first. */
export function approvedToPost(posts: ReviewPost[]): ReviewPost[] {
  return posts.filter((post) => post.status === 'approved').sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0));
}

/** What the app shows on a video about its review. null when it was never sent. */
export function reviewLabel(post: ReviewPost | undefined): { text: string; tone: 'waiting' | 'good' | 'bad' } | null {
  if (!post) return null;
  const who = post.decidedBy ? ` by ${post.decidedBy}` : '';
  switch (post.status) {
    case 'pending': return { text: 'Waiting for partner review', tone: 'waiting' };
    case 'approved': return { text: `Approved${who}, posting soon`, tone: 'good' };
    case 'posting': return { text: `Approved${who}, posting now`, tone: 'good' };
    case 'posted': return { text: `Approved${who} and posted`, tone: 'good' };
    case 'partly_posted': return { text: `Approved${who}, some socials failed`, tone: 'bad' };
    case 'failed': return { text: `Approved${who}, posting failed`, tone: 'bad' };
    case 'rejected': return { text: `Rejected${who}${post.note ? `: ${post.note}` : ''}`, tone: 'bad' };
    default: return null;
  }
}

/** A post can be (re)sent while nobody approved it yet. */
export function canSend(post: ReviewPost | undefined) {
  return !post || post.status === 'pending' || post.status === 'rejected';
}

/** What the review site offers for new videos: each brand with its socials and categories (with their defaults). */
export function reviewCatalog(workspace: Workspace): CatalogBrand[] {
  return workspace.brands.map((brand) => ({
    id: brand.id,
    name: brand.name,
    socials: PLATFORMS.map((platform) => platform.id).filter((platform) => workspace.accounts.some((account) => account.brandId === brand.id && account.platform === platform)),
    categories: (workspace.categories ?? []).filter((category) => category.brandId === brand.id)
      .map((category) => ({ id: category.id, name: category.name, ...(category.defaults ? { defaults: category.defaults } : {}) })),
  }));
}

/** Videos a reviewer made on the site that are not in Social Space yet, and whose brand and category still exist. */
export function partnerVideosToImport(posts: ReviewPost[], workspace: Workspace): ReviewPost[] {
  const have = new Set((workspace.videos ?? []).map((video) => video.id));
  return posts.filter((post) => post.source === 'partner' && post.mediaPath && !have.has(post.videoId)
    && (workspace.categories ?? []).some((category) => category.id === post.categoryId && category.brandId === post.brandId));
}

/** A reviewer's video as a library video, saved on this PC at mediaSource. */
export function partnerVideo(post: ReviewPost, mediaSource: string, now = Date.now()): Video {
  return {
    id: post.videoId, brandId: post.brandId!, categoryId: post.categoryId!, title: post.title, mediaSource, caption: post.description, posted: [], createdAt: now,
    details: { hashtags: post.hashtags ?? [], youtubeTitle: post.youtubeTitle || post.title.slice(0, 100), madeWithAi: post.madeWithAi, shareToFeed: true, madeForKids: false },
  };
}