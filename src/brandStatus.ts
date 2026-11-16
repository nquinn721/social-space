import { useEffect, useMemo, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getPlatform, PLATFORMS, type Account, type Platform, type Video, type Workspace } from './model';
import { postMode, type PostMode } from './postingMode';
import { wrongLogin } from './useBrowserPosting';
import { hasAccountPassword } from './profileService';
import type { ConnectionCheck } from './setupNeeds';
import type { BrandInstagram } from './useBrandInstagram';
import { useBrandFacebook, type BrandFacebook } from './useBrandFacebook';
import type { BrandSignIn } from './postingService';
import { useSignIns } from './useSignIns';

/**
 * Where a brand stands on each social, worked out from the real data: whether its profile exists, which
 * login it uses, whether Instagram is connected, whether the sign-in is saved. Every page reads this
 * instead of writing its own guesses, so the labels and the next step agree everywhere.
 *
 * Posting model: Instagram and Facebook (Page Reels) post through the Graph API (need their connection). TikTok, YouTube and X post
 * through their own upload page in a per-brand app window (needs the profile and its login). YouTube
 * channels live under the main Google account on purpose, so that is never a problem.
 */
export type SocialKind = 'no-profile' | 'not-created' | 'main-login' | 'checking' | 'connect' | 'reconnect' | 'sign-in' | 'no-password' | 'ready';
export type Tone = 'ok' | 'ready' | 'todo' | 'problem' | 'muted' | 'checking';
export type SocialAction = 'create' | 'finish-signup' | 'own-login' | 'connect' | 'sign-in' | 'save-login';
export type SocialStatus = {
  platform: Platform;
  account?: Account;
  kind: SocialKind;
  tone: Tone;
  /** Two or three words, for a chip. */
  label: string;
  /** One sentence on what it means. */
  detail: string;
  /** What fixes it, when something does. */
  action?: { kind: SocialAction; label: string; short: string };
  /** Whether a video can be posted there now. */
  canPost: boolean;
  via: PostMode;
};
/** What the app knows about connections and saved sign-ins; a missing entry means still checking. */
export type StatusInputs = {
  connections?: Record<string, ConnectionCheck | undefined>;
  passwords?: Record<string, boolean | undefined>;
  /** Whether this brand's window is signed in on each social (checked when it was last open). */
  signIns?: Partial<Record<Platform, BrandSignIn>>;
};

const via = (platform: Platform) => postMode(platform);
const viaText = (platform: Platform) => via(platform) === 'api' ? 'Posts by itself through the API.' : 'Posts through its upload page in a brand window; you press Post.';

export function socialStatus(workspace: Workspace, brandId: string, platform: Platform, inputs: StatusInputs = {}): SocialStatus {
  const name = getPlatform(platform).name;
  const account = workspace.accounts.find((item) => item.brandId === brandId && item.platform === platform && item.status === 'active')
    ?? workspace.accounts.find((item) => item.brandId === brandId && item.platform === platform);
  const base = { platform, account, via: via(platform) };
  // Brand Pages are made in the SoftWings business portfolio, so a brand without one here only needs its Page attached.
  if (!account && platform === 'facebook') return { ...base, kind: 'no-profile', tone: 'todo', label: 'No Page connected', detail: 'Connect the brand\'s Facebook Page (made in the SoftWings business portfolio) so videos post there as Reels.', action: { kind: 'connect', label: 'Connect Facebook Page', short: 'Connect' }, canPost: false };
  if (!account) return { ...base, kind: 'no-profile', tone: 'muted', label: 'No profile', detail: `This brand has no ${name} profile.`, action: { kind: 'create', label: `Create ${name} profile`, short: 'Create' }, canPost: false };
  if (account.status !== 'active') return { ...base, kind: 'not-created', tone: 'todo', label: 'Not created yet', detail: `Saved here, but the ${name} account isn't made yet.`, action: { kind: 'finish-signup', label: 'Finish sign-up', short: 'Sign up' }, canPost: false };
  if (wrongLogin(workspace.developerLogins, account)) return { ...base, kind: 'main-login', tone: 'problem', label: 'Uses main Gmail', detail: `${name} needs its own email per account, but this profile is saved with your main Gmail.`, action: { kind: 'own-login', label: 'Give it its own login', short: 'Fix login' }, canPost: false };
  if (platform === 'instagram') {
    const check = inputs.connections?.[account.id];
    if (!check) return { ...base, kind: 'checking', tone: 'checking', label: 'Checking…', detail: 'Checking the Instagram connection.', canPost: false };
    const connectedAs = check.username.replace(/^@/, '');
    if (check.state === 'ok' && connectedAs && account.handle && connectedAs.toLowerCase() !== account.handle.replace(/^@/, '').toLowerCase()) {
      return { ...base, kind: 'reconnect', tone: 'problem', label: `Connected as @${connectedAs}`, detail: `Meta connected @${connectedAs}, not @${account.handle.replace(/^@/, '')}, so posts would go to @${connectedAs}. Connect again and pick @${account.handle.replace(/^@/, '')} in the Meta window.`, action: { kind: 'connect', label: 'Reconnect Instagram', short: 'Reconnect' }, canPost: false };
    }
    if (check.state === 'ok') return { ...base, kind: 'ready', tone: 'ok', label: 'Ready', detail: `Connected${check.username ? ` as @${check.username.replace(/^@/, '')}` : ''}. ${viaText(platform)}`, canPost: true };
    if (check.state === 'expired') return { ...base, kind: 'reconnect', tone: 'problem', label: 'Reconnect', detail: check.detail || 'The Instagram connection ran out.', action: { kind: 'connect', label: 'Reconnect Instagram', short: 'Reconnect' }, canPost: false };
    return { ...base, kind: 'connect', tone: 'todo', label: 'Not connected', detail: 'Connect it through Meta so the app can post Reels for it.', action: { kind: 'connect', label: 'Connect Instagram', short: 'Connect' }, canPost: false };
  }
  if (platform === 'facebook') {
    // A Facebook profile is the brand's Page. It has no login of its own (it sits under your Facebook account),
    // so only its Page connection matters.
    const check = inputs.connections?.[account.id];
    if (!check) return { ...base, kind: 'checking', tone: 'checking', label: 'Checking…', detail: 'Checking the Facebook Page connection.', canPost: false };
    if (check.state === 'ok') return { ...base, kind: 'ready', tone: 'ok', label: 'Ready', detail: `Connected${check.username ? ` to the Page ${check.username}` : ''}. ${viaText(platform)}`, canPost: true };
    if (check.state === 'expired') return { ...base, kind: 'reconnect', tone: 'problem', label: 'Reconnect', detail: check.detail || 'The Facebook Page connection stopped working.', action: { kind: 'connect', label: 'Reconnect Facebook', short: 'Reconnect' }, canPost: false };
    return { ...base, kind: 'connect', tone: 'todo', label: 'Not connected', detail: 'Connect the brand\'s Page through Meta so the app can post Reels to it.', action: { kind: 'connect', label: 'Connect Facebook Page', short: 'Connect' }, canPost: false };
  }
  // The brand window posts as whoever it is signed in as, so a window that isn't signed in comes first.
  // Posting still works: the window asks for the sign-in and fills it.
  const signIn = inputs.signIns?.[platform];
  if (via(platform) === 'browser' && signIn && !signIn.signedIn) {
    return { ...base, kind: 'sign-in', tone: 'todo', label: 'Not signed in', detail: `The ${name} window isn't signed in. Sign in once and it stays signed in.`, action: { kind: 'sign-in', label: `Sign in to ${name}`, short: 'Sign in' }, canPost: true };
  }
  // YouTube channels sit under the main Google account by design: nothing to save per brand.
  const ownLogin = platform !== 'youtube';
  if (ownLogin && inputs.passwords && inputs.passwords[account.id] === false) {
    return { ...base, kind: 'no-password', tone: 'todo', label: 'Login not saved', detail: 'You can post, but the window can only fill the sign-in once its username and password are saved.', action: { kind: 'save-login', label: 'Save its login', short: 'Save login' }, canPost: true };
  }
  return { ...base, kind: 'ready', tone: 'ok', label: 'Ready', detail: viaText(platform), canPost: true };
}

/** The brand's status on every social, in platform order. */
export function brandStatuses(workspace: Workspace, brandId: string, inputs: StatusInputs = {}): SocialStatus[] {
  return PLATFORMS.map(({ id }) => socialStatus(workspace, brandId, id, inputs));
}
/** Only the socials the brand has a profile on (planned or live). */
export const withProfile = (statuses: SocialStatus[]) => statuses.filter((status) => status.kind !== 'no-profile');

/** A word or two for a small chip. */
export function chipLabel(status: SocialStatus): string {
  switch (status.kind) {
    case 'ready': return 'Ready';
    case 'no-profile': return 'None';
    case 'checking': return '…';
    case 'no-password': return 'Save login';
    case 'sign-in': return 'Sign in';
    default: return status.action?.short ?? status.label;
  }
}
/** A one-line summary of a brand, e.g. "Ready on 3 of 4 · Instagram not connected". */
export function brandSummary(statuses: SocialStatus[]): { tone: Tone; text: string; short: string } {
  const own = withProfile(statuses);
  if (own.length === 0) return { tone: 'muted', text: 'No profiles yet', short: 'No profiles yet' };
  const ready = own.filter((status) => status.canPost).length;
  const blocking = own.filter((status) => !status.canPost && status.kind !== 'checking');
  const checking = own.some((status) => status.kind === 'checking');
  if (blocking.length === 0) return { tone: checking ? 'checking' : 'ok', text: checking ? `Ready on ${ready} of ${own.length} · checking…` : `Ready to post on all ${own.length}`, short: checking ? 'Checking…' : `Ready on all ${own.length}` };
  const first = blocking[0];
  const more = blocking.length > 1 ? ` +${blocking.length - 1} more` : '';
  return { tone: blocking.some((status) => status.tone === 'problem') ? 'problem' : 'todo', text: `Ready on ${ready} of ${own.length} · ${getPlatform(first.platform).name}: ${first.label.toLowerCase()}${more}`, short: `Ready on ${ready} of ${own.length} · ${blocking.length} to fix` };
}

/** How far one video is across the brand's socials. */
export type VideoProgress = { posted: Platform[]; toDo: Platform[]; total: number; state: 'making' | 'failed' | 'waiting' | 'partial' | 'done' };
export function videoProgress(video: Video, socials: Platform[]): VideoProgress {
  const posted = socials.filter((platform) => video.posted.includes(platform));
  const toDo = socials.filter((platform) => !video.posted.includes(platform));
  const state = video.generation ? (video.generation.status === 'failed' ? 'failed' : 'making')
    : socials.length > 0 && toDo.length === 0 ? 'done' : posted.length > 0 ? 'partial' : 'waiting';
  return { posted, toDo, total: socials.length, state };
}
export function progressLabel(progress: VideoProgress): string {
  switch (progress.state) {
    case 'making': return 'Being made';
    case 'failed': return 'Not made';
    case 'done': return progress.total === 1 ? 'Posted' : 'Posted everywhere';
    case 'partial': return `Posted on ${progress.posted.length} of ${progress.total}`;
    default: return progress.total ? 'Ready to post' : 'No socials yet';
  }
}

/**
 * Checks what the status needs for a set of profiles: Instagram connections (passed in by the caller, who
 * already checks them) and whether each own-login profile's password is saved. Outside the desktop app
 * nothing can be checked, so passwords stay unknown rather than shown as missing.
 */
export function useSavedPasswords(accounts: Account[]): Record<string, boolean | undefined> {
  const [passwords, setPasswords] = useState<Record<string, boolean | undefined>>({});
  const ids = accounts.filter((account) => account.status === 'active' && account.platform !== 'youtube' && account.platform !== 'instagram' && account.platform !== 'facebook').map((account) => account.id).join('|');
  useEffect(() => {
    if (!ids || !isTauri()) return;
    let live = true;
    for (const id of ids.split('|')) {
      hasAccountPassword(id).then((saved) => { if (live) setPasswords((current) => ({ ...current, [id]: saved })); }).catch(() => undefined);
    }
    return () => { live = false; };
  }, [ids]);
  return useMemo(() => passwords, [passwords]);
}

/** The brand's Instagram connection as a status input: null while checking, and only Meta logins can upload files. */
export function instagramConnection(instagram: BrandInstagram | null): Record<string, ConnectionCheck | undefined> {
  if (!instagram || instagram.connected === null) return {};
  if (!instagram.connected) return { [instagram.accountId]: { state: 'none', username: '', detail: '' } };
  if (!instagram.canUploadFiles) return { [instagram.accountId]: { state: 'expired', username: instagram.username, detail: 'Connected with an Instagram login, which can\'t upload videos from this PC. Connect again through Meta.' } };
  return { [instagram.accountId]: { state: 'ok', username: instagram.username, detail: '' } };
}

/** The brand's Facebook Page connection as a status input: nothing while checking. */
export function facebookConnection(facebook: BrandFacebook | null): Record<string, ConnectionCheck | undefined> {
  if (!facebook || facebook.connected === null) return {};
  return { [facebook.accountId]: facebook.connected ? { state: 'ok', username: facebook.page, detail: '' } : { state: 'none', username: '', detail: '' } };
}

/** A brand's status on every social, with its Instagram and Facebook connections and saved logins checked. */
export function useBrandStatuses(workspace: Workspace, brandId: string | undefined, instagram: BrandInstagram | null): SocialStatus[] {
  const passwords = useSavedPasswords(workspace.accounts.filter((account) => account.brandId === brandId));
  const signIns = useSignIns()[brandId ?? ''];
  const facebook = useBrandFacebook(workspace, brandId);
  return useMemo(() => brandId ? brandStatuses(workspace, brandId, { connections: { ...instagramConnection(instagram), ...facebookConnection(facebook) }, passwords, signIns }) : [], [workspace, brandId, instagram, facebook, passwords, signIns]);
}
