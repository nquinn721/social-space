import { reviewStatus, type ReviewState } from './appReviews';
import type { DevProvider } from './devAppsService';
import type { Platform } from './model';

/**
 * How each social gets a video: 'api' posts it from the app by itself, 'browser' opens the social's own
 * upload page in an app window with everything filled in, for Nate to press Post.
 * Instagram posts through the Graph API. TikTok (Sandbox) and YouTube (audit) post through the browser
 * until their review is approved and API uploading is built for them; X posts through the browser too.
 */
export type PostMode = 'api' | 'browser';
/** Socials the app can upload to by itself today. */
export const API_UPLOADS: Platform[] = ['instagram'];
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
  const review = apiReview(marks, platform);
  if (!review) return 'Posts through its own page in a Social Space window: everything is filled in, you press Post.';
  if (review.state === 'approved') return 'App review approved, so API posting can now be added. Until then it posts through its own page in a Social Space window.';
  return 'Posts through its own page in a Social Space window until the app review is approved: everything is filled in, you press Post.';
}
