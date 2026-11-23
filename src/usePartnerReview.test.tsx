import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { isTauri } from '@tauri-apps/api/core';
import type { Workspace } from './model';
import { usePartnerReview } from './usePartnerReview';
import { claimReviewPost, importReviewVideo, listReviewPosts, publishReviewCatalog, recordReviewResult, reviewConnection, type ReviewPost } from './reviewService';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('./reviewService', () => ({ claimReviewPost: vi.fn(), listReviewPosts: vi.fn(), recordReviewResult: vi.fn(), reviewConnection: vi.fn(), submitForReview: vi.fn(), publishReviewCatalog: vi.fn(), importReviewVideo: vi.fn() }));

const workspace: Workspace = {
  businessName: '', channels: [], brands: [{ id: 'b1', name: 'Animals', notes: '' }],
  accounts: [{ id: 'ig1', platform: 'instagram', label: 'Animals', handle: '@animals', status: 'active', notes: '', brandId: 'b1' }],
  categories: [{ id: 'c1', brandId: 'b1', name: 'Rabbit' }],
  videos: [{ id: 'v1', brandId: 'b1', categoryId: 'c1', title: 'Bunny', mediaSource: 'C:\\v\\bunny.mp4', caption: 'old', posted: [], createdAt: 1 }],
};
const approved: ReviewPost = {
  id: 'v1', videoId: 'v1', title: 'Bunny', brand: 'Animals', category: 'Rabbit', youtubeTitle: '', description: 'Approved text', hashtags: ['bunny'],
  platforms: ['instagram', 'tiktok'], madeWithAi: false, status: 'approved', submittedAt: 1, decidedBy: 'p@x.com', decidedAt: 2, events: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(reviewConnection).mockResolvedValue({ clientEmail: 'sa@p.iam.gserviceaccount.com', projectId: 'socialspace-review', site: 'https://socialspace-review.web.app' });
  vi.mocked(recordReviewResult).mockResolvedValue();
  vi.mocked(claimReviewPost).mockResolvedValue(true);
  vi.mocked(publishReviewCatalog).mockResolvedValue();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('usePartnerReview', () => {
  it('puts an approved post in the queue with the approved text, and records that Ayrshare schedules it', async () => {
    vi.mocked(listReviewPosts).mockResolvedValueOnce([approved]).mockResolvedValue([{ ...approved, status: 'posted' }]);
    const save = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => usePartnerReview(workspace, true, save));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(claimReviewPost).toHaveBeenCalledWith('v1');
    const [, status, results, events] = vi.mocked(recordReviewResult).mock.calls[0];
    expect(status).toBe('posted');
    expect(results).toMatchObject({ instagram: { status: 'manual' }, tiktok: { status: 'manual' } });
    expect(events.map((event) => event.text)).toEqual(["Instagram is in Social Space's queue, scheduled through Ayrshare", "TikTok is in Social Space's queue, scheduled through Ayrshare"]);
    const [saved, message] = save.mock.calls[0] as [Workspace, string];
    expect(saved.videos?.[0]).toMatchObject({ posted: [], caption: 'Approved text' });
    expect(message).toContain('is in the queue');
    await waitFor(() => expect(result.current.posts.v1?.status).toBe('posted'));
  });

  it('leaves an approved post alone when the other PC claimed it first', async () => {
    vi.mocked(listReviewPosts).mockResolvedValue([approved]);
    vi.mocked(claimReviewPost).mockResolvedValue(false);
    const save = vi.fn();
    renderHook(() => usePartnerReview(workspace, true, save));
    await waitFor(() => expect(claimReviewPost).toHaveBeenCalledWith('v1'));
    expect(recordReviewResult).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not touch an approved post whose video is on the other PC', async () => {
    vi.mocked(listReviewPosts).mockResolvedValue([{ ...approved, id: 'v9', videoId: 'v9' }]);
    const { result } = renderHook(() => usePartnerReview(workspace, true, vi.fn()));
    await waitFor(() => expect(result.current.posts.v9).toBeDefined());
    expect(claimReviewPost).not.toHaveBeenCalled();
    expect(recordReviewResult).not.toHaveBeenCalled();
  });

  it('brings a video the partner made on the site into its brand and category, once', async () => {
    const made: ReviewPost = { ...approved, id: 'p1', videoId: 'p1', source: 'partner', status: 'pending', title: 'Snow day', description: 'Fresh snow',
      brandId: 'b1', categoryId: 'c1', mediaPath: 'uploads/u1/p1.mp4', createdBy: 'p@x.com' };
    vi.mocked(listReviewPosts).mockResolvedValue([made]);
    vi.mocked(importReviewVideo).mockResolvedValue('C:\\Users\\me\\Videos\\SocialSpace\\Animals\\Rabbit\\Snow day.mp4');
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() => usePartnerReview(workspace, true, save));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(importReviewVideo).toHaveBeenCalledWith('uploads/u1/p1.mp4', 'Animals', 'Rabbit', 'Snow day');
    const saved: Workspace = save.mock.calls[0][0];
    expect(saved.videos?.[1]).toMatchObject({ id: 'p1', brandId: 'b1', categoryId: 'c1', caption: 'Fresh snow', posted: [], mediaSource: expect.stringContaining('Snow day.mp4') });
    expect(recordReviewResult).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('socialspace.reviewImports') ?? '[]')).toEqual(['p1']);
  });

  it('keeps the brands and categories on the review site up to date', async () => {
    vi.mocked(listReviewPosts).mockResolvedValue([]);
    renderHook(() => usePartnerReview(workspace, true, vi.fn()));
    await waitFor(() => expect(publishReviewCatalog).toHaveBeenCalledWith([{ id: 'b1', name: 'Animals', socials: ['instagram'], categories: [{ id: 'c1', name: 'Rabbit' }] }]));
  });

  it('does not post before the workspace has loaded', async () => {
    vi.mocked(listReviewPosts).mockResolvedValue([approved]);
    const { result } = renderHook(() => usePartnerReview(workspace, false, vi.fn()));
    await waitFor(() => expect(result.current.posts.v1).toBeDefined());
    expect(recordReviewResult).not.toHaveBeenCalled();
  });
});
