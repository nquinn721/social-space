import { useMemo } from 'react';
import { getPlatform, PLATFORMS, type Account, type Platform, type Video, type Workspace } from './model';
import { wrongLogin } from './brandWindowService';
import type { BrandSocials } from './ayrshareService';
import { useAyrshare } from './useAyrshare';

/**
 * Where a brand stands on each social, worked out from the real data: whether its profile exists and, for
 * posting, what Ayrshare says (is Ayrshare connected, does the brand have its Ayrshare profile, is this social
 * linked on it). Every page reads this instead of writing its own guesses, so labels and next steps agree.
 */
export type SocialKind = 'no-profile' | 'not-created' | 'main-login' | 'checking' | 'no-ayrshare' | 'no-brand-profile' | 'not-linked' | 'relink' | 'no-x-keys' | 'ready';
export type Tone = 'ok' | 'ready' | 'todo' | 'problem' | 'muted' | 'checking';
/** connect-ayrshare: Settings → Ayrshare. setup-posting: make the brand's Ayrshare profile. link: open the linking page. x-keys: Settings → Ayrshare. */
export type SocialAction = 'create' | 'finish-signup' | 'own-login' | 'connect-ayrshare' | 'setup-posting' | 'link' | 'x-keys';
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
  /** Whether Ayrshare can post to it now. */
  canPost: boolean;
  /** The linked account's name on Ayrshare, when linked. */
  linkedAs?: string;
};
/** What Ayrshare said. Missing means still checking. ayrshare.connected false: no working API key. socials null: couldn't be read. */
export type StatusInputs = {
  ayrshare?: { connected: boolean; xKeys: boolean };
  socials?: BrandSocials | null;
};

export function socialStatus(workspace: Workspace, brandId: string, platform: Platform, inputs: StatusInputs = {}): SocialStatus {
  const name = getPlatform(platform).name;
  const account = workspace.accounts.find((item) => item.brandId === brandId && item.platform === platform && item.status === 'active')
    ?? workspace.accounts.find((item) => item.brandId === brandId && item.platform === platform);
  const base = { platform, account };
  const ayrshareLinked = inputs.ayrshare?.connected && inputs.socials?.hasProfile && inputs.socials.linked.some((item) => item.platform === platform);
  if (!account) return { ...base, kind: 'no-profile', tone: 'muted', label: 'No profile', detail: `This brand has no ${name} profile.`, action: { kind: 'create', label: `Create ${name} profile`, short: 'Create' }, canPost: false };
  // Linked on Ayrshare is the truth: the account exists and posts go there, whatever is saved here about it.
  if (account.status !== 'active' && !ayrshareLinked) return { ...base, kind: 'not-created', tone: 'todo', label: 'Not created yet', detail: `Saved here, but the ${name} account isn't made yet.`, action: { kind: 'finish-signup', label: 'Finish sign-up', short: 'Sign up' }, canPost: false };
  if (wrongLogin(account) && !ayrshareLinked) return { ...base, kind: 'main-login', tone: 'problem', label: 'Uses main Gmail', detail: `${name} needs the brand's own email, but this profile is saved with your main Gmail.`, action: { kind: 'own-login', label: 'Give it its own login', short: 'Fix login' }, canPost: false };
  const ayrshare = inputs.ayrshare;
  if (!ayrshare) return { ...base, kind: 'checking', tone: 'checking', label: 'Checking…', detail: 'Checking Ayrshare.', canPost: false };
  if (!ayrshare.connected) return { ...base, kind: 'no-ayrshare', tone: 'todo', label: 'Ayrshare not connected', detail: 'Posting goes through Ayrshare. Connect it under Settings → Ayrshare.', action: { kind: 'connect-ayrshare', label: 'Connect Ayrshare', short: 'Connect' }, canPost: false };
  const socials = inputs.socials;
  if (socials === undefined) return { ...base, kind: 'checking', tone: 'checking', label: 'Checking…', detail: 'Asking Ayrshare which socials are linked.', canPost: false };
  if (socials === null) return { ...base, kind: 'checking', tone: 'problem', label: 'Couldn\'t check', detail: 'Ayrshare could not be asked which socials are linked. Check again in a moment.', canPost: false };
  if (!socials.hasProfile) return { ...base, kind: 'no-brand-profile', tone: 'todo', label: 'Posting not set up', detail: 'The brand needs its Ayrshare profile, where its socials are linked.', action: { kind: 'setup-posting', label: 'Set up posting', short: 'Set up' }, canPost: false };
  const linked = socials.linked.find((item) => item.platform === platform);
  if (!linked) return { ...base, kind: 'not-linked', tone: 'todo', label: 'Not linked', detail: `Link ${account.handle ? `@${account.handle.replace(/^@/, '')}` : `the brand's ${name}`} on Ayrshare so posts can go there.`, action: { kind: 'link', label: `Link ${name}`, short: 'Link' }, canPost: false };
  const as = linked.name ? ` as ${platform === 'youtube' || platform === 'facebook' ? linked.name : `@${linked.name.replace(/^@/, '')}`}` : '';
  if (platform === 'x' && !ayrshare.xKeys) return { ...base, kind: 'no-x-keys', tone: 'todo', label: 'Needs X app keys', detail: 'X takes posts only with your own X app\'s API key and secret (X bills about 2¢ a post). Add them under Settings → Ayrshare.', action: { kind: 'x-keys', label: 'Add X app keys', short: 'Add keys' }, canPost: false, linkedAs: linked.name };
  if (linked.refresh) return { ...base, kind: 'relink', tone: 'problem', label: 'Link again', detail: `Linked${as}, but ${name} wants the link renewed soon. Link it again.`, action: { kind: 'link', label: `Link ${name} again`, short: 'Relink' }, canPost: true, linkedAs: linked.name };
  return { ...base, kind: 'ready', tone: 'ok', label: 'Ready', detail: `Linked${as}. Posts go out through Ayrshare.`, canPost: true, linkedAs: linked.name };
}

/** The brand's status on every social, in platform order. */
export function brandStatuses(workspace: Workspace, brandId: string, inputs: StatusInputs = {}): SocialStatus[] {
  return PLATFORMS.map(({ id }) => socialStatus(workspace, brandId, id, inputs));
}
/** Only the socials the brand has a profile on (planned or live). */
export const withProfile = (statuses: SocialStatus[]) => statuses.filter((status) => status.kind !== 'no-profile');

/** Socials that need something done before posts can go there. */
export const needsAttention = (status: SocialStatus) => status.kind !== 'ready' && (status.tone === 'todo' || status.tone === 'problem');

/**
 * The one thing a brand needs for posting, from Ayrshare's linked state: set up its Ayrshare profile, link the
 * socials that aren't linked yet (made here or not), link one again, or add the X app keys. Nothing while
 * Ayrshare isn't connected or is still being asked, since that is one step for every brand.
 */
export type BrandToDo = { kind: 'setup' | 'link' | 'relink' | 'x-keys'; platforms: Platform[]; label: string; detail: string };
export function brandToDo(statuses: SocialStatus[]): BrandToDo | null {
  const own = withProfile(statuses);
  if (own.some((status) => status.kind === 'no-ayrshare' || status.kind === 'checking')) return null;
  if (own.some((status) => status.kind === 'no-brand-profile')) return { kind: 'setup', platforms: [], label: 'Set up posting', detail: 'Makes its Ayrshare profile; then you link its socials.' };
  const names = (list: SocialStatus[]) => list.map((status) => getPlatform(status.platform).name).join(', ');
  const unlinked = own.filter((status) => status.kind === 'not-linked' || status.kind === 'not-created' || status.kind === 'main-login');
  if (unlinked.length) return { kind: 'link', platforms: unlinked.map((status) => status.platform), label: 'Link socials', detail: `Not linked in Ayrshare yet: ${names(unlinked)}.` };
  const relink = own.filter((status) => status.kind === 'relink');
  if (relink.length) return { kind: 'relink', platforms: relink.map((status) => status.platform), label: 'Link again', detail: `${names(relink)} ${relink.length === 1 ? 'wants' : 'want'} the link renewed.` };
  const keys = own.filter((status) => status.kind === 'no-x-keys');
  if (keys.length) return { kind: 'x-keys', platforms: ['x'], label: 'Add X app keys', detail: 'X takes posts only with your own X app\'s keys.' };
  return null;
}

/** A word or two for a small chip. */
export function chipLabel(status: SocialStatus): string {
  switch (status.kind) {
    case 'ready': return 'Ready';
    case 'no-profile': return 'Not added';
    case 'checking': return status.tone === 'problem' ? 'Not checked' : '…';
    case 'no-ayrshare': return 'No Ayrshare';
    default: return status.action?.short ?? status.label;
  }
}
/** A one-line summary of a brand, e.g. "Ready on 3 of 4 · Instagram: not linked". */
export function brandSummary(statuses: SocialStatus[]): { tone: Tone; text: string; short: string } {
  const own = withProfile(statuses);
  if (own.length === 0) return { tone: 'muted', text: 'No profiles yet', short: 'No profiles yet' };
  if (own.some((status) => status.kind === 'no-ayrshare')) return { tone: 'todo', text: 'Connect Ayrshare under Settings to post', short: 'Connect Ayrshare to post' };
  if (own.some((status) => status.kind === 'no-brand-profile')) return { tone: 'todo', text: 'Set up posting: the brand needs its Ayrshare profile', short: 'Set up posting' };
  const ready = own.filter((status) => status.canPost).length;
  const blocking = own.filter((status) => !status.canPost && status.kind !== 'checking');
  const checking = own.some((status) => status.kind === 'checking' && status.tone === 'checking');
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
export function progressLabel(progress: VideoProgress, scheduled = 0): string {
  switch (progress.state) {
    case 'making': return 'Being made';
    case 'failed': return 'Not made';
    case 'done': return progress.total === 1 ? 'Posted' : 'Posted everywhere';
    case 'partial': return `Posted on ${progress.posted.length} of ${progress.total}`;
    default: return !progress.total ? 'No socials yet' : scheduled ? 'Scheduled' : 'Waiting in queue';
  }
}

/** The brand's status on every social, from what Ayrshare says (read once by the Ayrshare provider). */
export function useBrandStatuses(workspace: Workspace, brandId: string | undefined): SocialStatus[] {
  const ayrshare = useAyrshare();
  const inputs = ayrshare.inputs(brandId);
  return useMemo(() => brandId ? brandStatuses(workspace, brandId, inputs) : [], [workspace, brandId, inputs]);
}
/** Every brand's statuses, for lists. */
export function useAllStatuses(workspace: Workspace): Record<string, SocialStatus[]> {
  const ayrshare = useAyrshare();
  return useMemo(() => Object.fromEntries(workspace.brands.map((brand) => [brand.id, brandStatuses(workspace, brand.id, ayrshare.inputs(brand.id))])), [workspace, ayrshare]);
}
