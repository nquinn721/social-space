import type { Workspace } from './model';
import { isLocalVideo } from './videoFileService';

/**
 * Three-way merging of workspaces, used two ways:
 * - Team sync: this PC's shared parts against the other PC's, relative to the last synced copy.
 * - Saves that were prepared before a sync changed the workspace: the save is replayed on top.
 * A change on only one side wins; when both sides changed the same item, `local` wins.
 */

/**
 * The parts of the workspace both PCs share: everything except where each video's file sits on this PC
 * (`mediaSource`), which every PC keeps for itself.
 */
export type SharedWorkspace = Pick<Workspace, 'businessName' | 'brands' | 'accounts' | 'channels'> & {
  categories: NonNullable<Workspace['categories']>; setup: Record<string, number>;
  videos: NonNullable<Workspace['videos']>; developerLogins: NonNullable<Workspace['developerLogins']>;
};

const LISTS = ['brands', 'accounts', 'channels', 'categories', 'videos'] as const;
type ListKey = typeof LISTS[number];
type Item = { id: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function sharedOf(workspace: Workspace): SharedWorkspace {
  return {
    businessName: workspace.businessName, brands: workspace.brands, accounts: workspace.accounts, channels: workspace.channels,
    categories: workspace.categories ?? [], setup: workspace.setup ?? {}, developerLogins: workspace.developerLogins ?? {},
    // A file on this PC means nothing on the other; a web link does.
    videos: (workspace.videos ?? []).map((video) => (isLocalVideo(video.mediaSource) ? { ...video, mediaSource: '' } : video)),
  };
}

/** One list, item by item. Order follows `remote`, then items only `local` has. */
export function mergeList<T extends Item>(base: T[], local: T[], remote: T[]): T[] {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const ids = [...new Set([...remote.map((item) => item.id), ...local.map((item) => item.id)])];
  const merged: T[] = [];
  for (const id of ids) {
    const was = baseById.get(id), mine = localById.get(id), theirs = remoteById.get(id);
    const pick = same(mine, was) ? theirs : same(theirs, was) ? mine : mine ?? theirs;
    // Deleted on one side and edited on the other: the edit wins and the item comes back.
    if (pick) merged.push(pick);
  }
  return merged;
}

function mergeRecord<T>(base: Record<string, T>, local: Record<string, T>, remote: Record<string, T>) {
  const merged: Record<string, T> = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const value = same(local[key], base[key]) ? remote[key] : same(remote[key], base[key]) ? local[key] : local[key] ?? remote[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

const scalar = <T,>(base: T, local: T, remote: T) => (local === base ? remote : local);

/** Merges two whole workspaces (all lists, including videos) against the one both started from. */
export function mergeWorkspaces(base: Workspace, local: Workspace, remote: Workspace): Workspace {
  const merged: Workspace = { ...remote, ...local, businessName: scalar(base.businessName, local.businessName, remote.businessName) };
  for (const key of LISTS) {
    (merged as Record<ListKey, Item[]>)[key] = mergeList<Item>(base[key] ?? [], local[key] ?? [], remote[key] ?? []);
  }
  const setup = mergeRecord(base.setup ?? {}, local.setup ?? {}, remote.setup ?? {});
  if (Object.keys(setup).length) merged.setup = setup; else delete merged.setup;
  const logins = mergeRecord(base.developerLogins ?? {}, local.developerLogins ?? {}, remote.developerLogins ?? {});
  if (Object.keys(logins).length) merged.developerLogins = logins; else delete merged.developerLogins;
  return merged;
}

const key = (text: string) => text.trim().toLowerCase();

/**
 * The first sync on a PC that joins an existing team: a local brand with the same name as a shared one
 * becomes that brand (its accounts, categories and videos move over), and a local account that is the
 * same profile as a shared one (same brand, social and handle) is dropped in favour of the shared one.
 */
export function adoptRemoteIds(local: Workspace, remote: SharedWorkspace): Workspace {
  const brandIds = new Map<string, string>();
  for (const brand of local.brands) {
    const match = remote.brands.find((other) => key(other.name) === key(brand.name));
    if (match && match.id !== brand.id) brandIds.set(brand.id, match.id);
  }
  const brand = (id: string | undefined) => (id && brandIds.get(id)) ?? id;
  const accounts = local.accounts
    .map((account) => ({ ...account, brandId: brand(account.brandId) }))
    .filter((account) => !remote.accounts.some((other) => other.id !== account.id && other.brandId === account.brandId && other.platform === account.platform && key(other.handle) === key(account.handle)));
  const accountIds = new Set(accounts.map((account) => account.id));
  const categoryIds = new Map<string, string>();
  const categories = (local.categories ?? []).flatMap((category) => {
    const brandId = brand(category.brandId)!;
    const match = remote.categories.find((other) => other.brandId === brandId && key(other.name) === key(category.name));
    if (match && match.id !== category.id) { categoryIds.set(category.id, match.id); return []; }
    return [{ ...category, brandId }];
  });
  return {
    ...local,
    brands: local.brands.filter((item) => !brandIds.has(item.id)),
    accounts,
    channels: local.channels.map((channel) => channel.accountId && !accountIds.has(channel.accountId) ? { ...channel, accountId: null } : channel),
    categories,
    videos: (local.videos ?? []).map((video) => ({ ...video, brandId: brand(video.brandId)!, categoryId: categoryIds.get(video.categoryId) ?? video.categoryId })),
  };
}

/**
 * Puts merged shared parts into this PC's workspace and repairs links the merge may have cut: a
 * category (and its brand) that this PC's videos still use comes back, an account whose brand was
 * deleted keeps it, and a channel whose account is gone is unlinked.
 */
export function withShared(local: Workspace, shared: SharedWorkspace): Workspace {
  // Each video keeps the file this PC has for it; one made on the other PC has none here yet.
  const files = new Map((local.videos ?? []).map((video) => [video.id, video.mediaSource]));
  const videos = (shared.videos ?? []).map((video) => {
    const mine = files.get(video.id);
    return mine && isLocalVideo(mine) && !video.mediaSource ? { ...video, mediaSource: mine } : video;
  });
  const brands = [...shared.brands];
  const categories = [...shared.categories];
  const restoreBrand = (id: string | undefined) => {
    if (!id || brands.some((brand) => brand.id === id)) return;
    const old = local.brands.find((brand) => brand.id === id);
    if (old) brands.push(old);
  };
  for (const video of videos) {
    if (!categories.some((category) => category.id === video.categoryId)) {
      const old = (local.categories ?? []).find((category) => category.id === video.categoryId);
      if (old) categories.push(old);
    }
  }
  for (const category of categories) restoreBrand(category.brandId);
  for (const account of shared.accounts) restoreBrand(account.brandId);
  const accountIds = new Set(shared.accounts.map((account) => account.id));
  const channels = shared.channels.map((channel) => channel.accountId && !accountIds.has(channel.accountId) ? { ...channel, accountId: null } : channel);
  const next: Workspace = { ...local, businessName: shared.businessName, brands, accounts: shared.accounts, channels, categories, videos };
  if (Object.keys(shared.setup).length) next.setup = shared.setup; else delete next.setup;
  if (Object.keys(shared.developerLogins ?? {}).length) next.developerLogins = shared.developerLogins; else delete next.developerLogins;
  return next;
}

/** Merges this PC's shared parts with the server's. `base` is null on this PC's first sync. */
export function mergeShared(base: SharedWorkspace | null, local: Workspace, remote: SharedWorkspace | null): Workspace {
  if (!remote) return local;
  const mine = base ? local : adoptRemoteIds(local, remote);
  // On the first sync the shared business name is kept, unless nothing has been shared yet.
  // Payloads from before 0.16 have no videos or developer logins; those count as empty.
  const from = base ?? { businessName: mine.businessName, brands: [], accounts: [], channels: [], categories: [], setup: {}, videos: [], developerLogins: {} };
  const merged = mergeWorkspaces(from, sharedOf(mine), { ...remote, businessName: remote.businessName || mine.businessName });
  return withShared(mine, sharedOf(merged));
}
