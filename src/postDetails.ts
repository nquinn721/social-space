import type { Platform, PostDetails, Video, VideoCategory } from './model';

/** Every video is a post from the start: being made, waiting for approval, or up on every social of its brand. */
export type Stage = 'making' | 'review' | 'posted';
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'making', label: 'Making' },
  { id: 'review', label: 'To approve' },
  { id: 'posted', label: 'Posted' },
];

export function videoStage(video: Video, socials: Platform[]): Stage {
  if (video.generation) return 'making';
  if (socials.length > 0 && socials.every((platform) => video.posted.includes(platform))) return 'posted';
  return 'review';
}

export const DEFAULT_DETAILS: PostDetails = { hashtags: [], youtubeTitle: '', madeWithAi: false, shareToFeed: true, madeForKids: false };
/** A video's post details, with defaults filled in. Videos made in the app start labeled as AI-made. */
export function detailsOf(video: Video): PostDetails {
  return { ...DEFAULT_DETAILS, ...video.details, youtubeTitle: video.details?.youtubeTitle || video.title.slice(0, YOUTUBE_TITLE_LIMIT) };
}

/**
 * What the Post panel starts with: what was saved for the video, or else its category's
 * saved description and hashtags.
 */
export function startingPost(video: Video, category?: VideoCategory): { caption: string; details: PostDetails } {
  const details = detailsOf(video);
  const defaults = category?.defaults;
  return {
    caption: video.caption.trim() ? video.caption : defaults?.caption ?? '',
    details: video.details?.hashtags.length || !defaults ? details : { ...details, hashtags: defaults.hashtags },
  };
}

/** A new video's post, started from its category's saved description and hashtags. */
export function newPost(category: VideoCategory, madeWithAi: boolean): Pick<Video, 'caption' | 'details'> {
  return { caption: category.defaults?.caption ?? '', details: { ...DEFAULT_DETAILS, hashtags: category.defaults?.hashtags ?? [], madeWithAi } };
}

/** Turns "bunny, #Cute snow" into ["bunny", "Cute", "snow"]: no #, no duplicates, letters, numbers and _ only. */
export function parseHashtags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const tag = raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); tags.push(tag); }
  }
  return tags;
}
export const hashtagText = (tags: string[]) => tags.map((tag) => `#${tag}`).join(' ');

/** The text that goes out with the video: its description, then its hashtags. */
export function postText(video: Video): string {
  return [video.caption.trim(), hashtagText(detailsOf(video).hashtags)].filter(Boolean).join('\n\n');
}

export const YOUTUBE_TITLE_LIMIT = 100;
/** What each social accepts for one video post. */
export const LIMITS: Record<Platform, { text: number; hashtags?: number; label: string }> = {
  instagram: { text: 2200, hashtags: 30, label: 'Instagram caption' },
  tiktok: { text: 2200, label: 'TikTok caption' },
  youtube: { text: 5000, label: 'YouTube description' },
  x: { text: 280, label: 'X post' },
};

/** Problems that would stop a social from taking this video as it is, for the brand's socials only. */
export function detailProblems(video: Video, socials: Platform[]): string[] {
  const text = postText(video);
  const details = detailsOf(video);
  const problems: string[] = [];
  for (const platform of socials) {
    const limit = LIMITS[platform];
    if (text.length > limit.text) problems.push(`${limit.label} is ${text.length} characters; the limit is ${limit.text.toLocaleString()}.`);
    if (limit.hashtags && details.hashtags.length > limit.hashtags) problems.push(`${limit.label} allows ${limit.hashtags} hashtags; this has ${details.hashtags.length}.`);
  }
  if (socials.includes('youtube') && !details.youtubeTitle.trim()) problems.push('YouTube needs a title.');
  if (details.youtubeTitle.length > YOUTUBE_TITLE_LIMIT) problems.push(`YouTube titles are at most ${YOUTUBE_TITLE_LIMIT} characters.`);
  return problems;
}

/** 1500 → "0:01.5" */
export function formatMs(ms: number): string {
  const seconds = ms / 1000;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}
