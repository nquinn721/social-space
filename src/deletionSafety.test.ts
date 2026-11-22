import { describe, expect, it, vi } from 'vitest';
import { prepareProfileRemoval, removedProfileIds, scheduledForProfiles } from './deletionSafety';
import type { Workspace } from './model';

const workspace = {
  businessName: '', brands: [{ id: 'b', name: 'Mia', notes: '' }, { id: 'o', name: 'Owner', notes: '' }], channels: [],
  accounts: [
    { id: 'mia', platform: 'instagram', label: 'Mia', handle: 'mia', status: 'active', notes: '', brandId: 'b' },
    { id: 'mia-tt', platform: 'tiktok', label: 'Mia', handle: 'mia', status: 'active', notes: '', brandId: 'b' },
    { id: 'owner', platform: 'instagram', label: 'Owner', handle: 'owner', status: 'active', notes: '', brandId: 'o' },
  ],
  videos: [
    { id: 'v1', brandId: 'b', categoryId: 'c', title: 'One', mediaSource: '', caption: '', posted: ['tiktok'], createdAt: 1,
      scheduled: { instagram: { id: 'p1', at: 5, state: 'scheduled' }, tiktok: { id: 'p2', at: 4, state: 'posted' } } },
    { id: 'v2', brandId: 'o', categoryId: 'c', title: 'Two', mediaSource: '', caption: '', posted: [], createdAt: 2,
      scheduled: { instagram: { id: 'p3', at: 5, state: 'scheduled' } } },
  ],
} as Workspace;
const deps = (answers: boolean[]) => ({
  hasPassword: vi.fn(async () => true), cancel: vi.fn(async () => undefined),
  confirm: vi.fn((_message: string) => answers.shift() ?? false), isCurrent: () => true,
});

describe('removing a local profile', () => {
  it('finds only the scheduled posts of the profiles being removed', () => {
    expect(scheduledForProfiles(workspace, new Set(['mia', 'mia-tt']))).toEqual([{ brandId: 'b', videoId: 'v1', platform: 'instagram', id: 'p1' }]);
    expect(scheduledForProfiles(workspace, new Set(['owner'])).map((post) => post.id)).toEqual(['p3']);
  });
  it('cancels nothing if either confirmation is declined', async () => {
    for (const answers of [[false], [true, false]]) {
      const run = deps(answers);
      await expect(prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', run)).resolves.toBeNull();
      expect(run.cancel).not.toHaveBeenCalled();
    }
  });
  it('cancels the profile\'s scheduled posts once both are confirmed', async () => {
    const run = deps([true, true]);
    await expect(prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', run)).resolves.toBe(1);
    expect(run.cancel).toHaveBeenCalledWith({ brandId: 'b', videoId: 'v1', platform: 'instagram', id: 'p1' });
    expect(run.confirm.mock.calls[0][0]).toContain('1 scheduled post is cancelled in Ayrshare');
  });
  it('stops when the workspace changed or Ayrshare refuses', async () => {
    await expect(prepareProfileRemoval(workspace, new Set(['mia']), 'Remove?', { ...deps([true, true]), isCurrent: () => false })).rejects.toThrow('changed');
    const refusing = { ...deps([true, true]), cancel: vi.fn(async () => { throw new Error('No.'); }) };
    await expect(prepareProfileRemoval(workspace, new Set(['mia']), 'Remove?', refusing)).rejects.toThrow('nothing was removed');
  });
  it('keeps credentials for accounts retained or restored by concurrent workspace updates', () => {
    const saved = { ...workspace, accounts: workspace.accounts.filter((account) => account.id !== 'mia') };
    expect(removedProfileIds(new Set(['mia', 'owner']), saved, workspace)).toEqual([]);
    expect(removedProfileIds(new Set(['mia']), saved, saved)).toEqual(['mia']);
  });
});
