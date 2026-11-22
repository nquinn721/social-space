import { describe, expect, it } from 'vitest';
import type { Account, Platform, Video, Workspace } from './model';
import type { SocialStatus } from './brandStatus';
import { brandLanes, dailyLimitReason, dayStart, finishDay, leftToday, postedToday, queueOrder, todaysSteps, waitingFor } from './postQueue';
import { markPosted } from './useBrowserPosting';
import { moveTestVideos, withPosted } from './appReviews';
import { batchPlan } from './batchPosting';

const NOW = new Date(2026, 10, 22, 15, 0).getTime();
const account = (platform: Platform): Account => ({ id: `a-${platform}`, platform, label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b' });
let made = 0;
const video = (extra: Partial<Video> = {}): Video => ({ id: `v${++made}`, brandId: 'b', categoryId: 'c', title: `Video ${made}`, mediaSource: 'C:\\videos\\v.mp4', caption: 'Hi', posted: [], createdAt: made, ...extra });
const workspace = (videos: Video[], platforms: Platform[] = ['tiktok', 'x']): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts: platforms.map(account), channels: [], videos });
const status = (platform: Platform, canPost = true): SocialStatus => ({ platform, kind: canPost ? 'ready' : 'sign-in', tone: canPost ? 'ready' : 'todo', label: canPost ? 'Ready' : 'Sign in', detail: '', canPost, via: 'browser' });

describe('post queue', () => {
  it('counts only posts made today on that social', () => {
    const yesterday = dayStart(NOW) - 1000;
    const videos = [video({ posted: ['tiktok'], postedAt: { tiktok: NOW - 60_000 } }), video({ posted: ['tiktok'], postedAt: { tiktok: yesterday } }), video({ posted: ['tiktok'] }), video({ posted: ['x'], postedAt: { x: NOW } })];
    expect(postedToday(workspace(videos), 'b', 'tiktok', NOW)).toHaveLength(1);
    expect(leftToday(workspace(videos), 'b', 'tiktok', NOW)).toBe(2);
  });

  it('never lets more than 3 a day go to one account', () => {
    const today = [1, 2, 3].map((n) => video({ posted: ['tiktok'], postedAt: { tiktok: NOW - n * 1000 } }));
    const waiting = [video(), video(), video(), video()];
    const ws = workspace([...today, ...waiting]);
    expect(dailyLimitReason(ws, 'b', 'tiktok', NOW)).toMatch(/3 posts/);
    const lanes = brandLanes(ws, 'b', [status('tiktok'), status('x')], NOW);
    const tiktok = lanes.find((lane) => lane.platform === 'tiktok')!;
    expect(tiktok.due).toEqual([]);
    expect(tiktok.doneIn).toBe(2);
    const x = lanes.find((lane) => lane.platform === 'x')!;
    expect(x.due.map((item) => item.id)).toEqual(today.map((item) => item.id));
  });

  it('walks one account at a time, oldest first, skipping socials that cannot post', () => {
    const videos = [video(), video(), video(), video(), video()];
    const ws = workspace(videos, ['tiktok', 'x', 'youtube']);
    const steps = todaysSteps(brandLanes(ws, 'b', [status('tiktok'), status('x'), status('youtube', false)], NOW));
    expect(steps.map((step) => `${step.platform}:${step.videoId}`)).toEqual([
      ...videos.slice(0, 3).map((item) => `tiktok:${item.id}`),
      ...videos.slice(0, 3).map((item) => `x:${item.id}`),
    ]);
  });

  it('leaves out unfinished videos and keeps series parts in order', () => {
    const p2 = video({ seriesId: 's', episode: 2 });
    const p1 = video({ seriesId: 's', episode: 1 });
    const making = video({ generation: { sourceId: 's', sourceName: 'Grok', provider: 'grok', taskId: 't', prompt: '', status: 'working' } });
    const noFile = video({ mediaSource: '' });
    expect(queueOrder([p2, p1]).map((item) => item.id)).toEqual([p1.id, p2.id]);
    expect(waitingFor(workspace([p2, p1, making, noFile]), 'b', 'tiktok').map((item) => item.id)).toEqual([p1.id, p2.id]);
    const p4 = video({ seriesId: 't', episode: 2 });
    expect(waitingFor(workspace([p4]), 'b', 'tiktok')).toEqual([]);
  });

  it('says when the queue is done', () => {
    expect(finishDay(0, 3)).toBeNull();
    expect(finishDay(3, 3)).toBe(0);
    expect(finishDay(4, 3)).toBe(1);
    expect(finishDay(10, 1)).toBe(3);
    expect(finishDay(3, 0)).toBe(1);
  });
});

describe('recording when posts went up', () => {
  it('stamps the time on every way a post is recorded and clears it when undone', () => {
    const v = video();
    const marked = markPosted(workspace([v]), v.id, 'tiktok', NOW)!;
    expect(marked.videos![0].postedAt).toEqual({ tiktok: NOW });
    const toggled = withPosted(v, ['x'], undefined, NOW);
    expect(toggled.postedAt).toEqual({ x: NOW });
    expect(withPosted(toggled, [], undefined, NOW).postedAt).toBeUndefined();
    const moved = moveTestVideos([{ ...toggled, testPosts: { x: NOW } }], 'x')[0];
    expect(moved.postedAt).toBeUndefined();
  });

  it('blocks a batch destination whose account is full for today', () => {
    const v = video();
    const plan = batchPlan({ video: v, socials: ['tiktok'], statuses: [{ ...status('tiktok'), account: account('tiktok') }], instagramReady: false, facebookReady: false, browserAvailable: true,
      isOpen: () => false, isAsking: () => false, waitingOn: () => null, dailyLimit: () => 'full' });
    expect(plan[0]).toMatchObject({ method: 'blocked', reason: 'full' });
  });
});
