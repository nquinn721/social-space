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
 * (`mediaSource`), which every PC keeps for itself, and the posting times (`posting`), which only the PC
 * that schedules through Ayrshare uses.
 */
export type SharedWorkspace = Pick<Workspace, 'businessName' | 'brands' | 'accounts' | 'channels'> & {
  categories: NonNullable<Workspace['categories']>;
  videos: NonNullable<Workspace['videos']>;
  series: NonNullable<Workspace['series']>;
};

const LISTS = ['brands', 'accounts', 'channels', 'categories', 'videos', 'series'] as const;
type ListKey = typeof LISTS[number];
type Item = { id: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function sharedOf(workspace: Workspace): SharedWorkspace {
  return {
    businessName: workspace.businessName, brands: workspace.brands, accounts: workspace.accounts, channels: workspace.channels,
    categories: workspace.categories ?? [], series: workspace.series ?? [],
    // A file on this PC means nothing on the other; a web link does.
    videos: (workspace.videos ?? []).map((video) => {
      const shared = isLocalVideo(video.mediaSource) ? { ...video, mediaSource: '' } : video;
      return video.textEdit && isLocalVideo(video.textEdit.sourcePath) ? { ...shared, textEdit: { ...video.textEdit, sourcePath: '' } } : shared;
    }),
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

const scalar = <T,>(base: T, local: T, remote: T) => (local === base ? remote : local);

/** Merges two whole workspaces (all lists, including videos) against the one both started from. */
export function mergeWorkspaces(base: Workspace, local: Workspace, remote: Workspace): Workspace {
  const merged: Workspace = { ...remote, ...local, businessName: scalar(base.businessName, local.businessName, remote.businessName) };
  for (const key of LISTS) {
    (merged as Record<ListKey, Item[]>)[key] = mergeList<Item>(base[key] ?? [], local[key] ?? [], remote[key] ?? []);
  }
  if (!merged.series?.length) delete merged.series;
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
    ...(local.series ? { series: local.series.map((series) => ({ ...series, brandId: brand(series.brandId)!, categoryId: categoryIds.get(series.categoryId) ?? series.categoryId })) } : {}),
  };
}

/**
 * Puts merged shared parts into this PC's workspace and repairs links the merge may have cut: a
 * category (and its brand) that this PC's videos still use comes back, an account whose brand was
 * deleted keeps it, and a channel whose account is gone is unlinked.
 */
export function withShared(local: Workspace, shared: SharedWorkspace): Workspace {
  // Each video keeps the file this PC has for it; one made on the other PC has none here yet.
  const files = new Map((local.videos ?? []).map((video) => [video.id, video]));
  const videos = (shared.videos ?? []).map((video) => {
    const own = files.get(video.id);
    const mine = own?.mediaSource;
    const withFile = mine && isLocalVideo(mine) && !video.mediaSource ? { ...video, mediaSource: mine } : video;
    // The text editor's video without text is a file on this PC too.
    const source = own?.textEdit?.sourcePath;
    return withFile.textEdit && !withFile.textEdit.sourcePath && source && isLocalVideo(source) ? { ...withFile, textEdit: { ...withFile.textEdit, sourcePath: source } } : withFile;
  });
  const brands = [...shared.brands];
  const categories = [...shared.categories];
  // A series this PC's episodes still use comes back, like their category.
  const series = [...(shared.series ?? [])];
  for (const video of videos) {
    if (video.seriesId && !series.some((item) => item.id === video.seriesId)) {
      const old = (local.series ?? []).find((item) => item.id === video.seriesId);
      if (old) series.push(old);
    }
  }
  for (const item of series) {
    if (!categories.some((category) => category.id === item.categoryId)) {
      const old = (local.categories ?? []).find((category) => category.id === item.categoryId);
      if (old) categories.push(old);
    }
  }
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
  for (const item of series) restoreBrand(item.brandId);
  for (const account of shared.accounts) restoreBrand(account.brandId);
  const accountIds = new Set(shared.accounts.map((account) => account.id));
  const channels = shared.channels.map((channel) => channel.accountId && !accountIds.has(channel.accountId) ? { ...channel, accountId: null } : channel);
  const next: Workspace = { ...local, businessName: shared.businessName, brands, accounts: shared.accounts, channels, categories, videos };
  if (series.length) next.series = series; else delete next.series;
  return next;
}

/** Merges this PC's shared parts with the server's. `base` is null on this PC's first sync. */
export function mergeShared(base: SharedWorkspace | null, local: Workspace, remote: SharedWorkspace | null): Workspace {
  if (!remote) return local;
  const mine = base ? local : adoptRemoteIds(local, remote);
  // On the first sync the shared business name is kept, unless nothing has been shared yet.
  // Payloads from before 0.16 have no videos (and before 0.25 no series); those count as empty.
  const from = base ?? { businessName: mine.businessName, brands: [], accounts: [], channels: [], categories: [], videos: [], series: [] };
  // An app from before series sends none: its side counts as unchanged, so this PC's series are kept.
  const theirs = { ...remote, businessName: remote.businessName || mine.businessName, series: remote.series ?? from.series ?? [] };
  const merged = mergeWorkspaces(from, sharedOf(mine), theirs);
  return withShared(mine, sharedOf(merged));
}
