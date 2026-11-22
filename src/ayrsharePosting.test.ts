import { describe, expect, it } from 'vitest';
import type { Video, Workspace } from './model';
import { applyHistory, ayrshareDate, hasOpenPosts, mediaUsable, postBody, readPostResponse, withoutPost, withPost } from './ayrsharePosting';

const DAY = 86_400_000;
const video = (extra: Partial<Video> = {}): Video => ({ id: 'v1', brandId: 'b', categoryId: 'c', title: 'Bunny hops', mediaSource: 'C:\\v\\1.mp4', caption: 'A bunny', posted: [], createdAt: 1,
  details: { hashtags: ['#bunny'], youtubeTitle: '', madeWithAi: true, shareToFeed: true, madeForKids: false, coverMs: 1500 }, ...extra });
const workspace = (videos: Video[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts: [], channels: [], videos });

describe('what goes to Ayrshare', () => {
  it('writes dates the way Ayrshare wants them', () => {
    expect(ayrshareDate(Date.UTC(2026, 10, 23, 14, 0, 5, 678))).toBe('2026-11-23T14:00:05Z');
  });
  it('sends the caption, the video and each social\'s options, with the AI label', () => {
    const body = postBody(video(), 'youtube', 'https://cdn/x.mp4');
    expect(body).toMatchObject({ platforms: ['youtube'], mediaUrls: ['https://cdn/x.mp4'], isVideo: true,
      youTubeOptions: { title: 'Bunny hops', visibility: 'public', shorts: true, madeForKids: false, containsSyntheticMedia: true } });
    expect(body.post).toContain('A bunny');
    expect(body).not.toHaveProperty('scheduleDate');
    expect(postBody(video(), 'tiktok', 'u').tikTokOptions).toEqual({ visibility: 'public', isAIGenerated: true, thumbNailOffset: 1500 });
    expect(postBody(video(), 'instagram', 'u').instagramOptions).toEqual({ shareReelsFeed: true, isAIGenerated: true, thumbNailOffset: 1500 });
    expect(postBody(video(), 'facebook', 'u').faceBookOptions).toEqual({ reels: true, title: 'Bunny hops' });
    const x = postBody(video(), 'x', 'u');
    expect(x.platforms).toEqual(['twitter']);
    expect(x.twitterOptions).toEqual({ isAIGenerated: true });
    expect(x.post).toContain('#AIgenerated');
  });
  it('schedules with a key that stops the same slot posting twice', () => {
    const at = Date.UTC(2026, 10, 23, 14, 0);
    const body = postBody(video(), 'tiktok', 'u', at);
    expect(body.scheduleDate).toBe('2026-11-23T14:00:00Z');
    expect(body.idempotencyKey).toBe(`v1-tiktok-${at / 1000}`);
  });
});

describe('reading Ayrshare\'s answers', () => {
  it('tells posted, scheduled and failed apart', () => {
    expect(readPostResponse({ id: 'p', status: 'success', postIds: [{ platform: 'tiktok', status: 'success', postUrl: 'https://tiktok.com/@b/video/1' }] }, 'tiktok', 5))
      .toEqual({ post: { id: 'p', at: 5, state: 'posted' }, url: 'https://tiktok.com/@b/video/1' });
    expect(readPostResponse({ id: '', status: 'success', posts: [{ id: 'q', status: 'scheduled' }] }, 'x', 9)).toEqual({ post: { id: 'q', at: 9, state: 'scheduled' } });
    expect(readPostResponse({ id: 'r', status: 'error', errors: [{ platform: 'twitter', message: 'Duplicate' }] }, 'x', 9).post).toMatchObject({ state: 'failed', error: 'Duplicate' });
    expect(readPostResponse({ id: 'r', status: 'success', postIds: [{ platform: 'instagram', status: 'error' }] }, 'instagram', 9).post.state).toBe('failed');
  });
  it('records a post on the video and clears it again', () => {
    const posted = withPost(video(), 'tiktok', { post: { id: 'p', at: 7, state: 'posted' }, url: 'https://tiktok.com/x' });
    expect(posted).toMatchObject({ posted: ['tiktok'], postedAt: { tiktok: 7 }, links: { tiktok: 'https://tiktok.com/x' } });
    const scheduled = withPost(video(), 'x', { post: { id: 'q', at: 8, state: 'scheduled' } });
    expect(scheduled.posted).toEqual([]);
    expect(scheduled.scheduled?.x).toMatchObject({ state: 'scheduled' });
    expect(withoutPost(scheduled, 'x').scheduled).toEqual({});
  });
  it('reuses an upload only while Ayrshare still keeps it, and only for the same file', () => {
    const media = { url: 'https://cdn/a.mp4', at: 0, keepDays: 90, source: 'C:\\v\\1.mp4' };
    expect(mediaUsable(media, 'C:\\v\\1.mp4', 30 * DAY)).toBe(true);
    expect(mediaUsable(media, 'C:\\v\\1.mp4', 89 * DAY)).toBe(false);
    expect(mediaUsable(media, 'C:\\v\\2.mp4', DAY)).toBe(false);
    expect(mediaUsable(undefined, 'C:\\v\\1.mp4', DAY)).toBe(false);
  });
});

describe('Ayrshare history', () => {
  const now = 100 * DAY;
  const scheduled = (id: string, at = now + DAY) => ({ id, at, state: 'scheduled' as const });
  it('marks posts that went up, failed or were deleted, and changes nothing else', () => {
    const ws = workspace([
      video({ id: 'a', scheduled: { tiktok: scheduled('p1'), x: scheduled('p2'), instagram: scheduled('p3'), youtube: scheduled('p4') } }),
    ]);
    const history = [
      { id: 'p1', status: 'success', postIds: [{ platform: 'tiktok', status: 'success', postUrl: 'https://tiktok.com/1' }], scheduleDate: new Date(now - 1000).toISOString() },
      { id: 'p2', status: 'error', errors: [{ platform: 'twitter', message: 'X said no' }] },
      { id: 'p3', status: 'deleted' },
      { id: 'p4', status: 'pending' },
    ];
    const next = applyHistory(ws, 'b', history, now)!;
    const after = next.videos![0];
    expect(after.posted).toEqual(['tiktok']);
    expect(after.links?.tiktok).toBe('https://tiktok.com/1');
    expect(after.postedAt?.tiktok).toBe(now - 1000);
    expect(after.scheduled?.x).toMatchObject({ state: 'failed', error: 'X said no' });
    expect(after.scheduled?.instagram).toBeUndefined();
    expect(after.scheduled?.youtube).toMatchObject({ state: 'scheduled' });
    expect(applyHistory(next, 'b', history, now)).toBeNull();
  });
  it('calls a scheduled post lost only well after it was due', () => {
    const ws = workspace([video({ scheduled: { tiktok: scheduled('gone', now - 7 * 3_600_000), x: scheduled('soon', now - 3_600_000) } })]);
    const next = applyHistory(ws, 'b', [], now)!;
    expect(next.videos![0].scheduled?.tiktok?.state).toBe('failed');
    expect(next.videos![0].scheduled?.x?.state).toBe('scheduled');
    expect(hasOpenPosts(next, 'b')).toBe(true);
    expect(hasOpenPosts(workspace([video()]), 'b')).toBe(false);
  });
});
