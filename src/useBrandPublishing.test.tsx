import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Video, Workspace } from './model';
import { publishVideoToInstagram, useBrandInstagram } from './useBrandInstagram';
import { publishVideoToFacebook, useBrandFacebook } from './useBrandFacebook';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

const workspace: Workspace = {
  businessName: '', brands: [{ id: 'b', name: 'Brand', notes: '' }], channels: [],
  accounts: [
    { id: 'local-ig', platform: 'instagram', label: 'Brand', handle: 'brand', status: 'active', notes: '', brandId: 'b' },
    { id: 'local-fb', platform: 'facebook', label: 'Brand', handle: 'brand', status: 'active', notes: '', brandId: 'b' },
  ],
};
const video: Video = { id: 'v', brandId: 'b', categoryId: 'c', title: 'Video', mediaSource: 'video.mp4', caption: 'Caption', posted: [], createdAt: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'claim_instagram_connection') return { id: '101', username: 'brand', login: 'facebook' } as never;
    if (command === 'facebook_connection') return { id: '202', name: 'Brand Page' } as never;
    return { id: 'post' } as never;
  });
});
afterEach(cleanup);

describe('confirmed publishing destinations', () => {
  it('passes the Instagram provider identity captured by the connection check', async () => {
    const { result } = renderHook(() => useBrandInstagram(workspace, 'b'));
    await waitFor(() => expect(result.current?.providerId).toBe('101'));
    await publishVideoToInstagram(result.current!, video);
    expect(invoke).toHaveBeenCalledWith('publish_instagram_reel_file', expect.objectContaining({ profile: 'local-ig', expectedId: '101' }));
  });

  it('passes the Facebook Page identity captured by the connection check', async () => {
    const { result } = renderHook(() => useBrandFacebook(workspace, 'b'));
    await waitFor(() => expect(result.current?.pageId).toBe('202'));
    await publishVideoToFacebook(result.current!, video);
    expect(invoke).toHaveBeenCalledWith('publish_facebook_reel_file', expect.objectContaining({ profile: 'local-fb', expectedId: '202' }));
  });
});
