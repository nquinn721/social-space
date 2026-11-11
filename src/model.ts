import type { Channel } from './channelModel';
export type Platform = 'x' | 'instagram' | 'tiktok' | 'youtube';
export type View = 'overview' | 'accounts' | 'inbox' | 'updates' | 'settings';
export const VIEWS: View[] = ['overview', 'accounts', 'inbox', 'updates', 'settings'];
/** identity: where name and username are edited (Instagram's Accounts Center). */
export type PlatformAction = 'create' | 'manage' | 'post' | 'developer' | 'identity';
/** platformId: the account's own ID on the social (e.g. the Instagram account ID), when known. */
export type AccountProfile = { platformId?: string; displayName?: string; bio?: string; website?: string; signupEmail?: string; imagePath?: string; birthday?: string };
/**
 * One profile of a brand on one social. status says whether it really exists there:
 * 'planned' is only saved in Social Space and still has to be created, 'active' is live on the social.
 * brandId ties it to its brand; accounts saved before brands existed get one when the workspace loads.
 */
export type Account = { id: string; platform: Platform; label: string; handle: string; status: 'planned' | 'active'; notes: string; brandId?: string } & AccountProfile;
/** A brand or category, e.g. "Massage With Mia", that owns one profile per social. */
export type Brand = { id: string; name: string; notes: string };
/** Profile description limits on each platform, used to keep drafts postable. */
export const BIO_LIMITS: Record<Platform, number> = { instagram: 150, tiktok: 80, youtube: 1000, x: 160 };
/** What a category's new posts start with: a short description and its usual hashtags. */
export type PostDefaults = { caption: string; hashtags: string[] };
/** A segment of a brand, e.g. "Bunny" inside "Animals". It has no accounts of its own: its videos post to the brand's profiles. */
export type VideoCategory = { id: string; brandId: string; name: string; defaults?: PostDefaults };
/** One video of a category. It goes to every social of its brand; posted lists where it is up. */
/** An AI video source still making a library video. Cleared once the finished file is saved. */
export type VideoGeneration = { sourceId: string; sourceName: string; provider: 'kling' | 'grok'; taskId: string; prompt: string; status: 'working' | 'failed'; message?: string };
/**
 * What goes out with a video besides the file. The description is the video's caption.
 * coverMs: the moment of the video used as its cover. madeWithAi: labels it as AI-made where the social asks.
 * shareToFeed: an Instagram Reel also shows in the main feed. madeForKids: YouTube asks this of every upload.
 */
export type PostDetails = { hashtags: string[]; youtubeTitle: string; coverMs?: number; madeWithAi: boolean; shareToFeed: boolean; madeForKids: boolean };
/** prompt: what an AI-made video was asked to show, kept to help write its description. */
export type Video = { id: string; brandId: string; categoryId: string; title: string; mediaSource: string; caption: string; posted: Platform[]; createdAt: number; generation?: VideoGeneration; details?: PostDetails; prompt?: string };
/** setup: steps of the setup checklist ticked by hand, by step id, with when (ms). */
export type Workspace = { businessName: string; brands: Brand[]; accounts: Account[]; channels: Channel[]; categories?: VideoCategory[]; videos?: Video[]; setup?: Record<string, number> };
export const EMPTY_WORKSPACE: Workspace = { businessName: '', brands: [], accounts: [], channels: [] };
export const PLATFORMS: { id: Platform; name: string; description: string; color: string; mark: string; postLabel: string }[] = [
  { id: 'instagram', name: 'Instagram', description: 'Photos, reels & stories', color: '#fa5a8d', mark: '◎', postLabel: 'Open Instagram' },
  { id: 'tiktok', name: 'TikTok', description: 'Short-form video', color: '#44dfd4', mark: '♪', postLabel: 'Open TikTok Studio' },
  { id: 'youtube', name: 'YouTube', description: 'Videos, shorts & channels', color: '#ff5e66', mark: '▶', postLabel: 'Open YouTube Studio' },
  { id: 'x', name: 'X', description: 'Posts & conversations', color: '#ececf1', mark: '𝕏', postLabel: 'Open X' },
];
export function getPlatform(id: Platform) { return PLATFORMS.find((platform) => platform.id === id)!; }
export function accountCountLabel(count: number) { return `${count} ${count === 1 ? 'account' : 'accounts'}`; }
export function normalizeHandle(value: string) { return value.trim().replace(/^@+/, ''); }
export function createAccount(platform: Platform, label: string, handle: string, status: Account['status'], notes: string): Account {
  return { id: crypto.randomUUID(), platform, label: label.trim(), handle: normalizeHandle(handle), status, notes: notes.trim() };
}
