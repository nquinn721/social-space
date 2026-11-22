import { reviewStatus, type ReviewState } from './appReviews';
import type { DevProvider } from './devAppsService';
import type { Platform } from './model';

/**
 * How each social gets a video: 'api' posts it from the app by itself, 'browser' opens the social's own
 * upload page in an app window, for Nate to review and press Post.
 * Every brand's accounts are standalone (their own login, not under the main account or a business
 * portfolio), and Meta's API only publishes to Instagram accounts linked to a Page it manages, so Instagram
 * and Facebook post through their own pages in the brand's window like X. TikTok (Sandbox) and YouTube
 * (audit) post through the browser until their review is approved and API uploading is built for them.
 */
export type PostMode = 'api' | 'browser';
/** Socials the app can upload to by itself today. */
export const API_UPLOADS: Platform[] = [];
const PROVIDER: Partial<Record<Platform, DevProvider>> = { tiktok: 'tiktok', youtube: 'google' };

export function postMode(platform: Platform): PostMode { return API_UPLOADS.includes(platform) ? 'api' : 'browser'; }

/** The developer-app review that keeps a social's API from posting publicly, and where it stands. */
export function apiReview(marks: Record<string, number> | undefined, platform: Platform): { provider: DevProvider; state: ReviewState } | null {
  const provider = PROVIDER[platform];
  return provider ? { provider, state: reviewStatus(marks, provider).state } : null;
}

/** One line on how a social posts, for Settings and the Post panel. */
export function postModeNote(marks: Record<string, number> | undefined, platform: Platform): string {
  if (postMode(platform) === 'api') return 'Posts by itself through the API.';
  if (platform === 'x') return 'Opens X for you to attach the video, enter the text, and post yourself.';
  const review = apiReview(marks, platform);
  if (!review) return 'Opens its page in a Social Space window. Check the details, then post yourself.';
  if (review.state === 'approved') return 'App review approved, so API posting can now be added. Until then it posts through its own page in a Social Space window.';
  return 'Opens its page in a Social Space window until the app review is approved. Check the filled details, then post yourself.';
}
