import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Platform } from './model';

/**
 * Partner review: posts go to the review site, where a reviewer signed in with Google approves or
 * rejects them. Approved posts are then posted from this app.
 */
export const REVIEW_SITE = 'https://socialspace-review.web.app';

export type ReviewConnection = { clientEmail: string; projectId: string; site: string };
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'posting' | 'posted' | 'partly_posted' | 'failed';
/** How posting went on one social. manual: this app doesn't post there itself, so it is done by hand. */
export type PlatformResult = { status: 'posted' | 'failed' | 'manual'; url?: string; error?: string; at: number };
export type ReviewEvent = { at: number; text: string };
export type ReviewPost = {
  id: string; videoId: string; title: string; brand: string; category: string; youtubeTitle: string; description: string;
  hashtags: string[]; platforms: Platform[]; madeWithAi: boolean; coverMs?: number | null; mediaUrl?: string;
  status: ReviewStatus; submittedAt: number; source?: 'app' | 'partner'; createdBy?: string; brandId?: string; categoryId?: string; mediaPath?: string; decidedBy?: string; decidedAt?: number; note?: string; postedAt?: number;
  results?: Partial<Record<Platform, PlatformResult>>; events?: ReviewEvent[];
};
export type ReviewSubmission = {
  videoId: string; title: string; brand: string; category: string; youtubeTitle: string; description: string;
  hashtags: string[]; platforms: Platform[]; madeWithAi: boolean; coverMs: number | null; mediaSource: string;
};

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use partner review.'); }

export async function reviewConnection(): Promise<ReviewConnection | null> { if (!isTauri()) return null; return invoke('review_connection'); }
export async function connectReview(): Promise<ReviewConnection | null> { desktopOnly(); return invoke('connect_review'); }
export async function disconnectReview(): Promise<void> { desktopOnly(); return invoke('disconnect_review'); }
export async function listReviewers(): Promise<string[]> { desktopOnly(); return invoke('list_reviewers'); }
export async function addReviewer(email: string): Promise<void> { desktopOnly(); return invoke('add_reviewer', { email }); }
export async function removeReviewer(email: string): Promise<void> { desktopOnly(); return invoke('remove_reviewer', { email }); }
export async function listReviewPosts(): Promise<ReviewPost[]> { desktopOnly(); return invoke('list_review_posts'); }
export async function submitForReview(post: ReviewSubmission): Promise<ReviewPost> { desktopOnly(); return invoke('submit_for_review', { post }); }
export async function recordReviewResult(videoId: string, status: ReviewStatus, results: ReviewPost['results'], events: ReviewEvent[]): Promise<void> {
  desktopOnly(); return invoke('record_review_result', { videoId, status, results: results ?? {}, events });
}
/** Takes an approved post for this PC to publish; false when the other PC already took it. */
export async function claimReviewPost(videoId: string): Promise<boolean> { desktopOnly(); return invoke('claim_review_post', { videoId }); }
/** Saves the review key to a file for the partner's app; returns the file name, or null if cancelled. */
export async function exportReviewKey(): Promise<string | null> { desktopOnly(); return invoke('export_review_key'); }
export async function openReviewSite(): Promise<void> { desktopOnly(); return invoke('open_review_site'); }
/** The brands, their socials and categories a reviewer can make a video for. */
export type CatalogBrand = { id: string; name: string; socials: Platform[]; categories: { id: string; name: string; defaults?: { caption: string; hashtags: string[] } }[] };
export async function publishReviewCatalog(brands: CatalogBrand[]): Promise<void> { desktopOnly(); return invoke('publish_review_catalog', { brands }); }
/** Downloads a reviewer's upload into the brand's category folder; returns the file path. */
export async function importReviewVideo(mediaPath: string, brand: string, category: string, title: string): Promise<string> { desktopOnly(); return invoke('import_review_video', { mediaPath, brand, category, title }); }
