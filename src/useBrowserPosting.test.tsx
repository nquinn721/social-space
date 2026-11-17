import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './model';
import { onPostingUpdate, type PostingUpdate } from './postingService';
import { useBrowserPosting } from './useBrowserPosting';

vi.mock('./postingService', () => ({ onPostingUpdate: vi.fn(), openPostingWindow: vi.fn() }));

const workspace: Workspace = {
  businessName: '', channels: [], brands: [{ id: 'b1', name: 'Brand', notes: '' }], accounts: [],
  categories: [{ id: 'c1', brandId: 'b1', name: 'Videos' }],
  videos: [{ id: 'v1', brandId: 'b1', categoryId: 'c1', title: 'Video', mediaSource: 'video.mp4', caption: '', posted: [], createdAt: 1 }],
};
let update: (value: PostingUpdate) => void;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(onPostingUpdate).mockImplementation(async (handler) => { update = handler; return () => {}; });
});

describe('browser posting confirmation', () => {
  it('keeps the question and explains a failed save until retry succeeds', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useBrowserPosting(workspace, save));
    await waitFor(() => expect(onPostingUpdate).toHaveBeenCalled());
    act(() => update({ videoId: 'v1', platform: 'tiktok', state: 'closed', posted: false }));
    await act(async () => { await result.current.confirm({ videoId: 'v1', platform: 'tiktok' }, true); });
    expect(result.current.isAsking('v1', 'tiktok')).toBe(true);
    expect(result.current.confirmationError('v1', 'tiktok')).toMatch(/try yes again/i);
    await act(async () => { await result.current.confirm({ videoId: 'v1', platform: 'tiktok' }, true); });
    expect(result.current.isAsking('v1', 'tiktok')).toBe(false);
    expect(result.current.confirmationError('v1', 'tiktok')).toBeUndefined();
  });

  it('retains a concurrent window result and carries the first mark into its retry', async () => {
    let finish!: (value: boolean) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; })).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useBrowserPosting(workspace, save));
    await waitFor(() => expect(onPostingUpdate).toHaveBeenCalled());
    act(() => {
      update({ videoId: 'v1', platform: 'tiktok', state: 'posted', posted: true });
      update({ videoId: 'v1', platform: 'youtube', state: 'posted', posted: true });
    });
    expect(result.current.isConfirming).toBe(true);
    expect(result.current.isAsking('v1', 'youtube')).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
    await act(async () => { await result.current.confirm({ videoId: 'v1', platform: 'youtube' }, true); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].videos[0].posted).toEqual(['tiktok', 'youtube']);
    expect(result.current.isAsking('v1', 'youtube')).toBe(false);
  });
});
