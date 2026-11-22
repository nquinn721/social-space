import type { Platform, PostDetails, Video, VideoCategory } from './model';

/** Every video is a post from the start: being made, waiting for approval, or up on every social of its brand. */
export type Stage = 'making' | 'review' | 'posted';
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'making', label: 'Making' },
  { id: 'review', label: 'To post' },
  { id: 'posted', label: 'Posted' },
];

export function videoStage(video: Video, socials: Platform[]): Stage {
  if (video.generation) return 'making';
  if (socials.length > 0 && socials.every((platform) => video.posted.includes(platform))) return 'posted';
  return 'review';
}

/** Everything the app holds is labeled as AI-made unless Nate turns it off for an upload of his own. */
export const DEFAULT_DETAILS: PostDetails = { hashtags: [], youtubeTitle: '', madeWithAi: true, shareToFeed: true, madeForKids: false };
/**
 * Whether the app itself made the video with AI: a video source made it (or is making it), it is a part of
 * a series, or it was made with the text editor. Such a video is always labeled as AI-made.
 */
export function madeInApp(video: Video): boolean {
  return Boolean(video.generation || video.prompt || video.seriesId || video.textEdit);
}
/** A video's post details, with defaults filled in. Videos made in the app are always labeled as AI-made. */
export function detailsOf(video: Video): PostDetails {
  const details = { ...DEFAULT_DETAILS, ...video.details, youtubeTitle: video.details?.youtubeTitle || video.title.slice(0, YOUTUBE_TITLE_LIMIT) };
  return madeInApp(video) ? { ...details, madeWithAi: true } : details;
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

/** The hashtag that discloses an AI-made video where a social has no AI label of its own to set. */
export const AI_TAG = 'AIgenerated';
/**
 * Socials whose upload page has no AI label switch, so the disclosure goes in the text. TikTok
 * ("AI-generated content"), YouTube ("Altered or synthetic content"), Instagram and Facebook ("AI label")
 * get their own label set by the posting window.
 */
export const TEXT_LABEL_SOCIALS: Platform[] = ['x'];

/**
 * The text that goes out with the video: its description, then its hashtags. With labelInText (or for a
 * social in TEXT_LABEL_SOCIALS), an AI-made video also gets #AIgenerated, unless it already has it.
 */
export function postText(video: Video, platform?: Platform, labelInText = false): string {
  const details = detailsOf(video);
  const tags = [...details.hashtags];
  const label = details.madeWithAi && (labelInText || (platform != null && TEXT_LABEL_SOCIALS.includes(platform)));
  if (label && !tags.some((tag) => tag.toLowerCase() === AI_TAG.toLowerCase())) tags.push(AI_TAG);
  return [video.caption.trim(), hashtagText(tags)].filter(Boolean).join('\n\n');
}

export const YOUTUBE_TITLE_LIMIT = 100;
/** What each social accepts for one video post. */
export const LIMITS: Record<Platform, { text: number; hashtags?: number; label: string }> = {
  instagram: { text: 2200, hashtags: 30, label: 'Instagram caption' },
  tiktok: { text: 2200, label: 'TikTok caption' },
  youtube: { text: 5000, label: 'YouTube description' },
  x: { text: 280, label: 'X post' },
  facebook: { text: 2200, label: 'Facebook Reel description' },
};

/** Problems that would stop a social from taking this video as it is, for the brand's socials only. */
export function detailProblems(video: Video, socials: Platform[]): string[] {
  const details = detailsOf(video);
  const problems: string[] = [];
  for (const platform of socials) {
    const text = postText(video, platform);
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
