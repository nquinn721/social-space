import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(async () => undefined) }));
import { invoke } from '@tauri-apps/api/core';
import { deleteQueueJob } from './queueService';

describe('queue cancellation', () => {
  beforeEach(() => vi.clearAllMocks());
  it('passes the atomic unstarted-only guard for a brand removal', async () => {
    await deleteQueueJob('job-1', true);
    expect(invoke).toHaveBeenCalledWith('delete_queue_job', { id: 'job-1', onlyUnstarted: true });
  });
  it('keeps explicit ordinary queue removal available after review', async () => {
    await deleteQueueJob('job-1');
    expect(invoke).toHaveBeenCalledWith('delete_queue_job', { id: 'job-1', onlyUnstarted: false });
  });
});
