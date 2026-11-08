import type { Channel } from './channelModel';
export type Platform = 'x' | 'instagram' | 'tiktok' | 'youtube';
export type View = 'overview' | 'accounts' | 'inbox' | 'channels' | 'queue' | 'publishing' | 'creative' | 'sources' | 'settings';
export const VIEWS: View[] = ['overview', 'accounts', 'inbox', 'channels', 'queue', 'publishing', 'creative', 'sources', 'settings'];
export type PlatformAction = 'create' | 'manage' | 'post' | 'developer';
export type AccountProfile = { displayName?: string; bio?: string; website?: string; signupEmail?: string; imagePath?: string; birthday?: string };
/**
 * One profile of a brand on one social. status says whether it really exists there:
 * 'planned' is only saved in Socialspace and still has to be created, 'active' is live on the social.
 * brandId ties it to its brand; accounts saved before brands existed get one when the workspace loads.
 */
export type Account = { id: string; platform: Platform; label: string; handle: string; status: 'planned' | 'active'; notes: string; brandId?: string } & AccountProfile;
/** A brand or category, e.g. "Massage With Mia", that owns one profile per social. */
export type Brand = { id: string; name: string; notes: string };
/** Profile description limits on each platform, used to keep drafts postable. */
export const BIO_LIMITS: Record<Platform, number> = { instagram: 150, tiktok: 80, youtube: 1000, x: 160 };
export type Workspace = { businessName: string; brands: Brand[]; accounts: Account[]; channels: Channel[] };
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
