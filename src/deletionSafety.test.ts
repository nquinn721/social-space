import { describe, expect, it, vi } from 'vitest';
import { prepareProfileRemoval, queueForProfiles, removedProfileIds } from './deletionSafety';
import type { Workspace } from './model';
import type { QueueJob, QueueStatus } from './queueService';

const workspace = {
  accounts: [
    { id: 'mia', platform: 'instagram', label: 'Mia', handle: 'mia', status: 'active', notes: '' },
    { id: 'owner', platform: 'instagram', label: 'Owner', handle: 'owner', status: 'active', notes: '' },
  ],
  channels: [
    { id: 'mia-channel', accountId: 'mia', platform: 'instagram', name: 'Mia', handle: 'mia', notes: '' },
    { id: 'owner-channel', accountId: 'owner', platform: 'instagram', name: 'Owner', handle: 'owner', notes: '' },
  ],
} as Workspace;
const job = (id: string, channelId: string, status: QueueStatus): QueueJob => ({
  id, channelId, status, platform: 'instagram', channelName: 'Example', channelHandle: 'example',
  mediaSource: 'https://example.test/video.mp4', caption: '', scheduledAt: 123,
  mode: 'automatic', error: null, instagramAccountId: '123',
});

describe('removing a local profile', () => {
  it('selects only unfinished queue items for that profile, leaving the owner and posted items alone', () => {
    const jobs = [job('pending', 'mia-channel', 'scheduled'), job('due', 'mia-channel', 'manual_due'), job('posted', 'mia-channel', 'posted'), job('owner', 'owner-channel', 'scheduled')];
    expect(queueForProfiles(workspace, new Set(['mia']), jobs).map((item) => item.id)).toEqual(['pending', 'due']);
  });
  it('does not cancel any queued posts if either confirmation is declined', async () => {
    for (const answers of [[false], [true, false]]) {
      const confirm = vi.fn((_message: string) => answers.shift() ?? false);
      const cancel = vi.fn(async () => undefined);
      const deps = { list: async () => [job('pending', 'mia-channel', 'scheduled')], hasPassword: async () => true, cancel, confirm, isCurrent: () => true };
      expect(await prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', deps)).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
      expect(confirm.mock.calls[0][0]).toContain('live accounts and Pages remain');
    }
  });
  it('only cancels the selected profile’s queue once local removal and password loss are both confirmed', async () => {
    const cancel = vi.fn(async (_id: string) => undefined);
    const confirm = vi.fn((_message: string) => true);
    const deps = { list: async () => [job('mia', 'mia-channel', 'scheduled'), job('owner', 'owner-channel', 'scheduled')], hasPassword: async () => true, cancel, confirm, isCurrent: () => true };
    expect(await prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', deps)).toBe(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][0]).toContain('deletes the saved passwords');
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('mia', true);
  });
  it('leaves queue untouched while a post is publishing or the workspace changed', async () => {
    const cancel = vi.fn(async () => undefined);
    const deps = { list: async () => [job('pending', 'mia-channel', 'publishing')], hasPassword: async () => false, cancel, confirm: () => true, isCurrent: () => true };
    await expect(prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', deps)).rejects.toThrow('being published');
    await expect(prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', { ...deps, list: async () => [job('pending', 'mia-channel', 'scheduled')], isCurrent: () => false })).rejects.toThrow('workspace changed');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('requires the user to identify an unlinked queue item before removing it', async () => {
    const legacy = { ...workspace, channels: [...workspace.channels, { id: 'legacy', accountId: null, platform: 'instagram' as const, name: 'Legacy', handle: 'legacy', notes: '' }] };
    const cancel = vi.fn(async () => undefined);
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const deps = { list: async () => [job('legacy-job', 'legacy', 'scheduled')], hasPassword: async () => false, cancel, confirm, isCurrent: () => true };
    expect(await prepareProfileRemoval(legacy, new Set(['mia']), 'Remove Mia?', deps)).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm.mock.calls[1][0]).toContain('not linked to a saved account');
    confirm.mockReset().mockReturnValue(true);
    expect(await prepareProfileRemoval(legacy, new Set(['mia']), 'Remove Mia?', deps)).toBe(1);
    expect(cancel).toHaveBeenCalledWith('legacy-job', true);
  });
  it('requires the user to check an uncertain post before removing its queue record', async () => {
    const cancel = vi.fn(async () => undefined);
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const deps = { list: async () => [job('uncertain', 'mia-channel', 'needs_review')], hasPassword: async () => false, cancel, confirm, isCurrent: () => true };
    expect(await prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', deps)).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm.mock.calls[1][0]).toContain('checked the social');
    confirm.mockReset().mockReturnValue(true);
    expect(await prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', deps)).toBe(1);
    expect(cancel).toHaveBeenCalledWith('uncertain', false);
  });
  it('keeps credentials for accounts retained or restored by concurrent workspace updates', () => {
    const empty = { ...workspace, accounts: [] };
    expect(removedProfileIds(new Set(['mia', 'owner']), workspace, empty)).toEqual([]);
    expect(removedProfileIds(new Set(['mia', 'owner']), empty, workspace)).toEqual([]);
    expect(removedProfileIds(new Set(['mia', 'owner']), empty, { ...workspace, accounts: [workspace.accounts[0]] })).toEqual(['owner']);
  });
  it('reports partial queue cancellation and does not remove the profile when a later job changes', async () => {
    const cancel = vi.fn(async (id: string) => { if (id === 'second') throw new Error('Post is now being published.'); });
    const deps = { list: async () => [job('first', 'mia-channel', 'scheduled'), job('second', 'mia-channel', 'scheduled')], hasPassword: async () => false, cancel, confirm: () => true, isCurrent: () => true };
    await expect(prepareProfileRemoval(workspace, new Set(['mia']), 'Remove Mia?', deps)).rejects.toThrow('1 was already cancelled; the profile was not removed');
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
