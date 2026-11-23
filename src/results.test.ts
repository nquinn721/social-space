import { describe, expect, it } from 'vitest';
import type { Video, Workspace } from './model';
import { change, compact, followersGained, rangeTotals, readComments, readPostAnalytics, readSocialAnalytics, topVideos, viewsByDay, viewsBySocial } from './results';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 25, 12, 0).getTime();
const video = (id: string, extra: Partial<Video> = {}): Video => ({ id, brandId: 'b', categoryId: 'c', title: id, mediaSource: '', caption: '', posted: [], createdAt: 1, ...extra });
const ws = (videos: Video[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts: [], channels: [], videos });

describe('reading Ayrshare results', () => {
  it('reads views, likes, comments and shares whatever each social calls them', () => {
    const read = readPostAnalytics({
      status: 'success',
      tiktok: { analytics: { videoViews: 1200, likeCount: 80, commentsCount: 4, shareCount: 3 } },
      instagram: { analytics: { viewsCount: 500, likeCount: 20, commentsCount: 2, sharesCount: 1 } },
      youtube: { analytics: { views: 153, likes: 54, comments: 22 } },
      twitter: { analytics: { publicMetrics: { impressionCount: 90, likeCount: 5, replyCount: 1, retweetCount: 2 } } },
      facebook: { analytics: { videoViews: 40, reactions: { like: 3, total: 6 }, commentsCount: 0, sharesCount: 0 } },
    });
    expect(read).toEqual({
      tiktok: { views: 1200, likes: 80, comments: 4, shares: 3 }, instagram: { views: 500, likes: 20, comments: 2, shares: 1 },
      youtube: { views: 153, likes: 54, comments: 22, shares: 0 }, x: { views: 90, likes: 5, comments: 1, shares: 2 }, facebook: { views: 40, likes: 6, comments: 0, shares: 0 },
    });
    expect(readSocialAnalytics({ youtube: { analytics: { subscriberCount: '120' } }, tiktok: { analytics: { followerCount: 50 } }, facebook: { analytics: { fanCount: 7 } }, status: 'success' }))
      .toEqual({ youtube: 120, tiktok: 50, facebook: 7 });
  });
  it('reads comments, and counts one the brand replied to as answered', () => {
    const where = { brandId: 'b', videoId: 'v', postId: 'p' };
    const comments = readComments({
      status: 'success',
      instagram: [{ commentId: '17', comment: 'So cute!', created: '2026-11-24T10:00:00Z', userName: 'amy', replies: [{ userName: 'bunnyhops', comment: 'Thank you!' }] }],
      tiktok: [{ commentId: '9', comment: 'More please', createTime: 1_764_000_000, username: 'tom', videoId: '555', replies: [] }, { commentId: '10', comment: 'Mine', owner: true }],
    }, where, { instagram: '@bunnyhops' });
    expect(comments.map((item) => [item.platform, item.author, item.answered])).toEqual([['instagram', 'amy', true], ['tiktok', 'tom', false]]);
    expect(comments[1]).toMatchObject({ id: '9', socialVideoId: '555', at: 1_764_000_000_000 });
  });
});

describe('results over time', () => {
  const videos = [
    video('a', { posted: ['tiktok', 'x'], postedAt: { tiktok: NOW - DAY, x: NOW - DAY }, scheduled: { tiktok: { id: 't1', at: NOW - DAY, state: 'posted' }, x: { id: 'x1', at: NOW - DAY, state: 'posted' } } }),
    video('b', { posted: ['tiktok'], postedAt: { tiktok: NOW - 9 * DAY }, scheduled: { tiktok: { id: 't2', at: NOW - 9 * DAY, state: 'posted' } } }),
  ];
  const results = { t1: { views: 100, likes: 10, comments: 1, shares: 0, at: NOW }, x1: { views: 50, likes: 2, comments: 0, shares: 1, at: NOW }, t2: { views: 75, likes: 5, comments: 0, shares: 0, at: NOW } };
  it('counts posts in the range they went up in, against the range before', () => {
    expect(rangeTotals(ws(videos), results, '7d', NOW)).toEqual({ current: { views: 150, likes: 12, comments: 1, shares: 1 }, previous: { views: 75, likes: 5, comments: 0, shares: 0 } });
    expect(change(150, 75)).toBe(100);
    expect(change(5, 0)).toBeNull();
  });
  it('splits views by day and by social, and ranks videos', () => {
    const days = viewsByDay(ws(videos), results, 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[5].views).toBe(150);
    expect(viewsBySocial(ws(videos), results, NOW - 7 * DAY)).toEqual({ tiktok: { views: 100, likes: 10, comments: 1, shares: 0 }, x: { views: 50, likes: 2, comments: 0, shares: 1 } });
    expect(topVideos(ws(videos), results, NOW - 30 * DAY).map((item) => [item.video.id, item.total.views])).toEqual([['a', 150], ['b', 75]]);
  });
  it('works out new followers from the counts saved each day', () => {
    expect(followersGained([{ day: NOW, total: 10 }], 7, NOW)).toBeNull();
    expect(followersGained([{ day: NOW - 8 * DAY, total: 100 }, { day: NOW - 3 * DAY, total: 110 }, { day: NOW, total: 130 }], 7, NOW)).toBe(30);
    expect(compact(1530)).toBe('1.5K');
    expect(compact(25_000)).toBe('25K');
  });
});
