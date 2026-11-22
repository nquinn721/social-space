import type { Channel } from './channelModel';
export type Platform = 'x' | 'instagram' | 'tiktok' | 'youtube' | 'facebook';
export type View = 'overview' | 'accounts' | 'inbox' | 'updates' | 'settings';
export const VIEWS: View[] = ['overview', 'accounts', 'inbox', 'updates', 'settings'];
/** identity: where name and username are edited (Instagram's Accounts Center). */
export type PlatformAction = 'create' | 'addProfile' | 'manage' | 'post' | 'developer' | 'identity';
/** platformId: the account's own ID on the social (e.g. the Instagram account ID), when known. */
export type AccountProfile = { platformId?: string; displayName?: string; bio?: string; website?: string; signupEmail?: string; imagePath?: string; birthday?: string; /** This social's own picture instead of the brand's (a brand pictures file name, so it syncs). */ imageFile?: string; /** Channel keywords or tags (YouTube's channel keywords), without # signs. */ keywords?: string[] };
/**
 * One profile of a brand on one social. status says whether it really exists there:
 * 'planned' is only saved in Social Space and still has to be created, 'active' is live on the social.
 * brandId ties it to its brand; accounts saved before brands existed get one when the workspace loads.
 */
export type Account = { id: string; platform: Platform; label: string; handle: string; status: 'planned' | 'active'; notes: string; brandId?: string } & AccountProfile;
/** A brand or category, e.g. "Massage With Mia", that owns one profile per social. */
/** Names of files in the app's brand pictures folder (`<sha256>.jpg`), not paths, so they sync. */
export type BrandImage = { file: string; banner?: string; prompt?: string };
export type Brand = { id: string; name: string; notes: string; /** Used on every profile of the brand unless a profile has its own. */ image?: BrandImage };
/** Profile description limits on each platform, used to keep drafts postable. */
export const BIO_LIMITS: Record<Platform, number> = { instagram: 150, tiktok: 80, youtube: 1000, x: 160, facebook: 101 };
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
/** links: the live post on each social the app published it to. */
export type Video = { id: string; brandId: string; categoryId: string; title: string; mediaSource: string; caption: string; posted: Platform[]; createdAt: number; generation?: VideoGeneration; details?: PostDetails; prompt?: string; links?: Partial<Record<Platform, string>>; /** Socials it was marked posted on while their app was in test mode (TikTok Sandbox, YouTube before the audit), with when (ms). */ testPosts?: Partial<Record<Platform, number>>; /** The series this video is an episode of, and which part (1 is the first). */ seriesId?: string; episode?: number };
/** setup: steps of the setup checklist ticked by hand, by step id, with when (ms). */
/** A developer-site sign-in tracked by the app (one per social, on the main email). Its password is saved under developerPasswordId(provider). */
export type DeveloperLogin = { email: string };
/**
 * A recurring character of a series. imageFile is its reference picture (a brand pictures file name, so
 * it syncs); it goes to the video source with every episode so the character looks the same each time.
 */
export type SeriesCharacter = { id: string; name: string; description: string; imageFile?: string };
/** One part of a series: what happens (summary), its script, what the video source is asked to show, and its caption. */
export type SeriesEpisode = { id: string; number: number; title: string; summary: string; script?: string; videoPrompt?: string; caption?: string };
/**
 * A story told across several videos, posted in order as "Part N of M". Grok writes the story bible,
 * the episode arc and each script; the video source makes the clips (sourceId, or the active source when unset).
 * Its videos live in categoryId of its brand, linked back by Video.seriesId and Video.episode.
 */
export type Series = {
  id: string; brandId: string; categoryId: string; title: string; premise: string;
  /** The story bible: world, tone, rules and where the story is going. Every script is written from it. */
  bible: string;
  /** The complete editable narrative behind the series, absent on older series. */
  story?: string;
  /** The visual look every clip shares, e.g. "soft pastel 3D animation". */
  style?: string;
  characters: SeriesCharacter[]; episodes: SeriesEpisode[];
  sourceId?: string; aspectRatio: string; duration: number; createdAt: number;
};
export type Workspace = { businessName: string; brands: Brand[]; accounts: Account[]; channels: Channel[]; categories?: VideoCategory[]; videos?: Video[]; setup?: Record<string, number>; developerLogins?: Record<string, DeveloperLogin>; series?: Series[] };
/** Where a developer site's generated password is kept, next to the account passwords. */
export function developerPasswordId(provider: string) { return `developer-${provider}`; }
export const EMPTY_WORKSPACE: Workspace = { businessName: '', brands: [], accounts: [], channels: [] };
export const PLATFORMS: { id: Platform; name: string; description: string; color: string; mark: string; postLabel: string }[] = [
  { id: 'instagram', name: 'Instagram', description: 'Photos, reels & stories', color: '#fa5a8d', mark: '◎', postLabel: 'Open Instagram' },
  { id: 'tiktok', name: 'TikTok', description: 'Short-form video', color: '#44dfd4', mark: '♪', postLabel: 'Open TikTok Studio' },
  { id: 'youtube', name: 'YouTube', description: 'Videos, shorts & channels', color: '#ff5e66', mark: '▶', postLabel: 'Open YouTube Studio' },
  { id: 'x', name: 'X', description: 'Posts & conversations', color: '#ececf1', mark: '𝕏', postLabel: 'Open X' },
  { id: 'facebook', name: 'Facebook', description: 'Reels', color: '#4c8dff', mark: 'f', postLabel: 'Open Facebook' },
];
export function getPlatform(id: Platform) { return PLATFORMS.find((platform) => platform.id === id)!; }
export function accountCountLabel(count: number) { return `${count} ${count === 1 ? 'account' : 'accounts'}`; }
export function normalizeHandle(value: string) { return value.trim().replace(/^@+/, ''); }
export function createAccount(platform: Platform, label: string, handle: string, status: Account['status'], notes: string): Account {
  return { id: crypto.randomUUID(), platform, label: label.trim(), handle: normalizeHandle(handle), status, notes: notes.trim() };
}
