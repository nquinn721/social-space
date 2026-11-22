import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Platform } from './model';

/**
 * Posting goes through Ayrshare: one Ayrshare account (its API key, under Settings), one Ayrshare profile per
 * brand, and on each profile the brand's own Instagram, Facebook, TikTok, YouTube and X, linked on Ayrshare's
 * page. Keys live in Windows Credential Manager; these calls are the only way the app reaches Ayrshare.
 */
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to post through Ayrshare.'); }

/** Ayrshare's name for each social. */
export const NETWORK: Record<Platform, string> = { instagram: 'instagram', facebook: 'facebook', tiktok: 'tiktok', youtube: 'youtube', x: 'twitter' };
export const AYRSHARE_SITE = 'https://app.ayrshare.com';

/** connected: an API key is saved. working: Ayrshare accepted it just now (null when it couldn't be asked). */
export type AyrshareStatus = { connected: boolean; working: boolean | null; xKeys: boolean; account: string | null; detail: string | null };
export type LinkedSocial = { platform: Platform; name: string; refresh: boolean };
/** hasProfile: this PC has the brand's profile key. linked: the socials linked on that profile. */
export type BrandSocials = { hasProfile: boolean; linked: LinkedSocial[] };
export type BrandProfile = { refId: string; title: string };
export type UploadedMedia = { url: string; keepDays: number };
export type LinkLogin = { platform: Platform; accountId: string; handle: string; email: string };

/** One post as Ayrshare's history has it. scheduleDate is an ISO date, or a timestamp object on older posts. */
export type HistoryPost = {
  id: string; status: string; platforms?: string[]; type?: string; post?: string;
  postIds?: { platform?: string; status?: string; id?: string; postUrl?: string }[];
  errors?: { message?: string; platform?: string }[];
  scheduleDate?: string | { _seconds?: number; seconds?: number }; created?: string;
};
/** What /post answers. With a profile key the result can sit in posts[0]. */
export type PostResponse = HistoryPost & { posts?: HistoryPost[] };

export async function ayrshareStatus(): Promise<AyrshareStatus> {
  if (!isTauri()) return { connected: false, working: null, xKeys: false, account: null, detail: null };
  return invoke('ayrshare_status');
}
export async function saveAyrshareKey(apiKey: string): Promise<AyrshareStatus> { desktopOnly(); return invoke('ayrshare_save_key', { apiKey }); }
export async function disconnectAyrshare(): Promise<void> { desktopOnly(); return invoke('ayrshare_disconnect'); }
export async function saveXKeys(apiKey: string, apiSecret: string): Promise<void> { desktopOnly(); return invoke('ayrshare_save_x_keys', { apiKey, apiSecret }); }
export async function removeXKeys(): Promise<void> { desktopOnly(); return invoke('ayrshare_remove_x_keys'); }

export async function createBrandProfile(brandId: string, title: string): Promise<BrandProfile> { desktopOnly(); return invoke('ayrshare_create_profile', { brandId, title }); }
export async function adoptBrandProfile(brandId: string, profileKey: string): Promise<BrandProfile> { desktopOnly(); return invoke('ayrshare_use_profile', { brandId, profileKey }); }
export async function forgetBrandProfile(brandId: string): Promise<void> { desktopOnly(); return invoke('ayrshare_forget_profile', { brandId }); }
export async function brandSocials(brandId: string): Promise<BrandSocials> {
  if (!isTauri()) return { hasProfile: false, linked: [] };
  return invoke('ayrshare_brand_socials', { brandId });
}
export async function openLinking(brandId: string, brandName: string, logins: LinkLogin[]): Promise<void> {
  desktopOnly(); return invoke('ayrshare_open_linking', { brandId, brandName, logins });
}

export async function uploadVideo(path: string): Promise<UploadedMedia> { desktopOnly(); return invoke('ayrshare_upload_video', { path }); }
export async function sendPost(brandId: string, body: Record<string, unknown>): Promise<PostResponse> { desktopOnly(); return invoke('ayrshare_post', { brandId, body }); }
export async function postHistory(brandId: string): Promise<HistoryPost[]> {
  desktopOnly();
  const answer = await invoke<{ history?: HistoryPost[] }>('ayrshare_history', { brandId });
  return Array.isArray(answer?.history) ? answer.history : [];
}
export async function deletePost(brandId: string, id: string): Promise<void> { desktopOnly(); return invoke('ayrshare_delete_post', { brandId, id }); }
/** Opens a live post (its link from Ayrshare) in the default browser. */
export async function openPostLink(url: string): Promise<void> { desktopOnly(); return invoke('ayrshare_open_post', { url }); }
