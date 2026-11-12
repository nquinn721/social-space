import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './model';
import { syncOnce } from './useTeamSync';
import { teamSyncFetch, teamSyncPush } from './teamSyncService';
import { sharedOf } from './workspaceSync';

vi.mock('./teamSyncService', () => ({ teamSyncFetch: vi.fn(), teamSyncPush: vi.fn(), teamSyncStatus: vi.fn(), enableTeamSync: vi.fn(), disableTeamSync: vi.fn() }));

const local: Workspace = { businessName: 'Soft Wings', brands: [{ id: 'b1', name: 'Animals', notes: '' }], channels: [], categories: [], videos: [],
  accounts: [{ id: 'a1', platform: 'instagram', label: 'Animals', handle: 'animals', status: 'active', notes: '', brandId: 'b1' }] };

beforeEach(() => vi.resetAllMocks());

describe('syncOnce', () => {
  it('uploads without saving when nothing came in', async () => {
    vi.mocked(teamSyncFetch).mockResolvedValue({ rev: 0, remote: null, base: null, secretsReceived: 0 });
    vi.mocked(teamSyncPush).mockResolvedValue({ rev: 1, pushed: true, conflict: false });
    const apply = vi.fn();
    await syncOnce({ workspaceRef: { current: local }, apply });
    expect(apply).not.toHaveBeenCalled();
    expect(teamSyncFetch).toHaveBeenCalledWith(['a1']);
    expect(teamSyncPush).toHaveBeenCalledWith(sharedOf(local), ['a1']);
  });

  it('saves what the other PC changed, then pushes the merged result', async () => {
    const remote = sharedOf({ ...local, accounts: [{ ...local.accounts[0], bio: 'from partner' }] });
    vi.mocked(teamSyncFetch).mockResolvedValue({ rev: 4, remote, base: sharedOf(local), secretsReceived: 0 });
    vi.mocked(teamSyncPush).mockResolvedValue({ rev: 4, pushed: false, conflict: false });
    const ref = { current: local };
    const apply = vi.fn(async (next: Workspace) => { ref.current = next; return next; });
    await syncOnce({ workspaceRef: ref, apply });
    expect(apply.mock.calls[0][0].accounts[0].bio).toBe('from partner');
    expect(vi.mocked(teamSyncPush).mock.calls[0][0].accounts[0].bio).toBe('from partner');
  });

  it('starts over when the other PC wrote in between', async () => {
    vi.mocked(teamSyncFetch).mockResolvedValue({ rev: 0, remote: null, base: null, secretsReceived: 0 });
    vi.mocked(teamSyncPush).mockResolvedValueOnce({ rev: 0, pushed: false, conflict: true }).mockResolvedValue({ rev: 2, pushed: true, conflict: false });
    await syncOnce({ workspaceRef: { current: local }, apply: vi.fn() });
    expect(teamSyncFetch).toHaveBeenCalledTimes(2);
  });
});
