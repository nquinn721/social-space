import { describe, expect, it } from 'vitest';
import type { Account, Workspace } from './model';
import { mergeList, mergeShared, mergeWorkspaces, sharedOf, type SharedWorkspace } from './workspaceSync';

const account = (id: string, extra: Partial<Account> = {}): Account => ({ id, platform: 'instagram', label: 'Animals', handle: id, status: 'active', notes: '', brandId: 'b1', ...extra });
const base: Workspace = {
  businessName: 'Soft Wings', brands: [{ id: 'b1', name: 'Animals', notes: '' }], channels: [],
  accounts: [account('a1'), account('a2')],
  categories: [{ id: 'c1', brandId: 'b1', name: 'Rabbit' }],
  videos: [{ id: 'v1', brandId: 'b1', categoryId: 'c1', title: 'Bunny', mediaSource: 'C:\\bunny.mp4', caption: '', posted: [], createdAt: 1 }],
};

describe('mergeList', () => {
  it('keeps edits from both sides to different items', () => {
    const merged = mergeList(base.accounts, [account('a1', { bio: 'mine' }), account('a2')], [account('a1'), account('a2', { bio: 'theirs' })]);
    expect(merged.map((item) => item.bio)).toEqual(['mine', 'theirs']);
  });
  it('lets this PC win when both sides edited the same item', () => {
    expect(mergeList(base.accounts, [account('a1', { bio: 'mine' })], [account('a1', { bio: 'theirs' })])[0].bio).toBe('mine');
  });
  it('applies deletions and additions from either side', () => {
    const merged = mergeList(base.accounts, [account('a1'), account('a2'), account('a3')], [account('a1')]);
    expect(merged.map((item) => item.id)).toEqual(['a1', 'a3']);
  });
  it('keeps an item one side edited while the other deleted it', () => {
    expect(mergeList(base.accounts, [account('a1'), account('a2', { bio: 'edited' })], [account('a1')]).map((item) => item.id)).toEqual(['a1', 'a2']);
  });
});

describe('mergeWorkspaces', () => {
  it('replays a save prepared before a sync on top of what the sync brought in', () => {
    const save = { ...base, accounts: [account('a1', { bio: 'typed here' }), account('a2')] };
    const synced = { ...base, accounts: [...base.accounts, account('a9', { label: 'From partner' })] };
    const merged = mergeWorkspaces(base, save, synced);
    expect(merged.accounts.map((item) => item.id)).toEqual(['a1', 'a2', 'a9']);
    expect(merged.accounts[0].bio).toBe('typed here');
  });
});

describe('mergeShared', () => {
  const shared = (workspace: Workspace): SharedWorkspace => sharedOf(workspace);

  it('uploads everything on the first sync when nothing is shared yet', () => {
    expect(mergeShared(null, base, null)).toBe(base);
  });

  it('merges the partner change while keeping this PC\'s videos', () => {
    const remote = shared({ ...base, accounts: [account('a1', { bio: 'partner' }), account('a2')] });
    const merged = mergeShared(shared(base), base, remote);
    expect(merged.accounts[0].bio).toBe('partner');
    expect(merged.videos).toEqual(base.videos);
  });

  it('shares video records and post details but keeps each PC\'s own file', () => {
    const shared = sharedOf(base);
    expect(shared.videos[0].mediaSource).toBe('');
    const remote = { ...shared, videos: [{ ...shared.videos[0], caption: 'written by partner' }, { ...shared.videos[0], id: 'v2', title: 'New from partner' }] };
    const merged = mergeShared(sharedOf(base), base, remote);
    expect(merged.videos?.map((video) => [video.id, video.mediaSource, video.caption])).toEqual([['v1', base.videos![0].mediaSource, 'written by partner'], ['v2', '', '']]);
  });

  it('shares a video that is a web link as it is', () => {
    const linked = { ...base, videos: [{ ...base.videos![0], mediaSource: 'https://example.com/v.mp4' }] };
    expect(sharedOf(linked).videos[0].mediaSource).toBe('https://example.com/v.mp4');
  });

  it('brings in a new brand with its profiles and developer sign-ins from the other PC', () => {
    const remote = { ...sharedOf(base), brands: [...base.brands, { id: 'b2', name: 'Cooking', notes: '' }], accounts: [...base.accounts, account('k1', { brandId: 'b2', label: 'Cooking' })], developerLogins: { tiktok: { email: 'dev@x.com' } } };
    const merged = mergeShared(sharedOf(base), base, remote);
    expect(merged.brands.map((brand) => brand.name)).toEqual(['Animals', 'Cooking']);
    expect(merged.accounts.find((item) => item.id === 'k1')?.brandId).toBe('b2');
    expect(merged.developerLogins).toEqual({ tiktok: { email: 'dev@x.com' } });
  });

  it('reads a shared copy from before videos were shared', () => {
    const { videos: _v, developerLogins: _d, ...old } = sharedOf(base);
    const merged = mergeShared(old as SharedWorkspace, base, old as SharedWorkspace);
    expect(merged.videos?.[0].mediaSource).toBe(base.videos![0].mediaSource);
  });

  it('keeps a category this PC\'s videos use when the other PC deleted it', () => {
    const remote = shared({ ...base, categories: [] });
    expect(mergeShared(shared(base), base, remote).categories?.map((item) => item.id)).toEqual(['c1']);
  });

  it('unlinks a channel whose account was deleted on the other PC', () => {
    const local = { ...base, channels: [{ id: 'ch1', platform: 'instagram' as const, name: 'Main', handle: 'a2', accountId: 'a2', notes: '' }] };
    const remote = shared({ ...local, accounts: [account('a1')] });
    const merged = mergeShared(shared(local), local, remote);
    expect(merged.accounts.map((item) => item.id)).toEqual(['a1']);
    expect(merged.channels[0].accountId).toBeNull();
  });

  it('joins a team: a brand with the same name becomes the shared brand, and the same profile is not doubled', () => {
    const partner: Workspace = {
      businessName: '', brands: [{ id: 'pb', name: 'animals', notes: '' }, { id: 'pb2', name: 'Cooking', notes: '' }], channels: [],
      accounts: [account('pa1', { brandId: 'pb', handle: 'a1' }), account('pa2', { brandId: 'pb', platform: 'x', handle: 'animals_x' }), account('pa3', { brandId: 'pb2' })],
      categories: [{ id: 'pc1', brandId: 'pb', name: 'rabbit' }],
      videos: [{ id: 'pv', brandId: 'pb', categoryId: 'pc1', title: 'Hop', mediaSource: 'D:\\hop.mp4', caption: '', posted: [], createdAt: 2 }],
    };
    const merged = mergeShared(null, partner, shared(base));
    expect(merged.businessName).toBe('Soft Wings');
    expect(merged.brands.map((item) => item.id).sort()).toEqual(['b1', 'pb2']);
    expect(merged.accounts.map((item) => item.id).sort()).toEqual(['a1', 'a2', 'pa2', 'pa3']);
    expect(merged.accounts.find((item) => item.id === 'pa2')?.brandId).toBe('b1');
    expect(merged.videos?.[0]).toMatchObject({ brandId: 'b1', categoryId: 'c1' });
    expect(merged.categories?.map((item) => item.id)).toEqual(['c1']);
  });
});
