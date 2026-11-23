import { describe, expect, it } from 'vitest';
import type { Account, Platform, Video, Workspace } from './model';
import type { SocialStatus } from './brandStatus';
import { brandLanes, DAILY_LIMIT, dayStart, nextSlot, notReady, planSchedule, postingSettings, queueOrder, todayCount, usedSlots, waitingFor } from './postQueue';

const NOW = new Date(2026, 10, 22, 15, 0).getTime();
const at = (dayOffset: number, hours: number, minutes = 0) => { const day = new Date(NOW); day.setDate(day.getDate() + dayOffset); day.setHours(hours, minutes, 0, 0); return day.getTime(); };
const account = (platform: Platform): Account => ({ id: `a-${platform}`, platform, label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b' });
let made = 0;
const video = (extra: Partial<Video> = {}): Video => ({ id: `v${++made}`, brandId: 'b', categoryId: 'c', title: `Video ${made}`, mediaSource: 'C:\\videos\\v.mp4', caption: 'Hi', posted: [], createdAt: made, ...extra });
const workspace = (videos: Video[], platforms: Platform[] = ['tiktok', 'x']): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts: platforms.map(account), channels: [], videos });
const status = (platform: Platform, canPost = true): SocialStatus => ({ platform, kind: canPost ? 'ready' : 'not-linked', tone: canPost ? 'ok' : 'todo', label: canPost ? 'Ready' : 'Not linked', detail: '', canPost });
const TIMES = ['09:00', '13:00', '18:00'];

describe('posting settings', () => {
  it('defaults to automatic scheduling at three times a day, and keeps saved times sorted, valid and at most three', () => {
    expect(postingSettings(workspace([]))).toEqual({ autoSchedule: true, times: TIMES });
    expect(postingSettings({ ...workspace([]), posting: { autoSchedule: false, times: ['20:00', '08:30', 'bad', '08:30', '12:00', '23:00'] } }))
      .toEqual({ autoSchedule: false, times: ['08:30', '12:00', '20:00'] });
  });
});

describe('next free slot', () => {
  it('takes the next posting time at least 15 minutes from now', () => {
    expect(nextSlot([], TIMES, NOW)).toBe(at(0, 18));
    expect(nextSlot([], TIMES, at(0, 17, 50))).toBe(at(1, 9));
  });
  it('skips times already used and days that have their 3 posts', () => {
    expect(nextSlot([at(0, 18)], TIMES, NOW)).toBe(at(1, 9));
    const full = [at(1, 9), at(1, 10), at(1, 11)];
    expect(nextSlot([at(0, 18), ...full], TIMES, NOW)).toBe(at(2, 9));
  });
  it('stays after the last scheduled post, so the order holds', () => {
    expect(nextSlot([], TIMES, NOW, at(1, 13))).toBe(at(1, 18));
  });
});

describe('the schedule plan', () => {
  it('puts at most 3 a day on each account, oldest first, on every social that can post', () => {
    const videos = [video(), video(), video(), video(), video()];
    const plan = planSchedule(workspace(videos), 'b', ['tiktok', 'x'], NOW);
    const tiktok = plan.filter((item) => item.platform === 'tiktok');
    expect(tiktok.map((item) => item.videoId)).toEqual(videos.map((item) => item.id));
    expect(tiktok.map((item) => item.at)).toEqual([at(0, 18), at(1, 9), at(1, 13), at(1, 18), at(2, 9)]);
    expect(plan.filter((item) => item.platform === 'x')).toHaveLength(5);
    for (let day = 0; day < 3; day++) expect(tiktok.filter((item) => item.at >= at(day, 0) && item.at < at(day + 1, 0)).length).toBeLessThanOrEqual(DAILY_LIMIT);
  });
  it('fits around posts already up or scheduled today, and leaves those videos out', () => {
    const up = video({ posted: ['tiktok'], postedAt: { tiktok: at(0, 9) } });
    const booked = video({ scheduled: { tiktok: { id: 'p1', at: at(0, 18), state: 'scheduled' } } });
    const failed = video({ scheduled: { tiktok: { id: 'p2', at: at(0, 13), state: 'failed', error: 'no' } } });
    const next = video();
    const ws = workspace([up, booked, failed, next], ['tiktok']);
    expect(usedSlots(ws, 'b', 'tiktok')).toEqual([at(0, 9), at(0, 18)]);
    expect(todayCount(ws, 'b', 'tiktok', NOW)).toBe(2);
    expect(planSchedule(ws, 'b', ['tiktok'], NOW)).toEqual([{ brandId: 'b', platform: 'tiktok', videoId: next.id, at: at(1, 9) }]);
  });
  it('schedules only three weeks ahead; the rest waits in the app', () => {
    const videos = Array.from({ length: 100 }, () => video());
    const plan = planSchedule(workspace(videos, ['tiktok']), 'b', ['tiktok'], NOW);
    expect(plan.length).toBeGreaterThan(60);
    expect(plan.length).toBeLessThan(100);
    expect(Math.max(...plan.map((item) => item.at))).toBeLessThanOrEqual(NOW + 21 * 86_400_000);
  });
});

describe('queue order', () => {
  it('leaves out unfinished videos and keeps series parts in order', () => {
    const p2 = video({ seriesId: 's', episode: 2 });
    const p1 = video({ seriesId: 's', episode: 1 });
    const making = video({ generation: { sourceId: 's', sourceName: 'Grok', provider: 'grok', taskId: 't', prompt: '', status: 'working' } });
    const noFile = video({ mediaSource: '' });
    expect(queueOrder([p2, p1]).map((item) => item.id)).toEqual([p1.id, p2.id]);
    const ws = workspace([p2, p1, making, noFile]);
    expect(waitingFor(ws, 'b', 'tiktok').map((item) => item.id)).toEqual([p1.id, p2.id]);
    expect(notReady(ws, 'b').map((item) => item.id)).toEqual([making.id, noFile.id]);
    // Part 2 alone can't go before part 1 exists there.
    expect(waitingFor(workspace([video({ seriesId: 't', episode: 2 })]), 'b', 'tiktok')).toEqual([]);
    // A scheduled part 1 lets part 2 follow.
    const first = video({ seriesId: 'u', episode: 1, scheduled: { tiktok: { id: 'p', at: at(1, 9), state: 'scheduled' } } });
    const second = video({ seriesId: 'u', episode: 2 });
    expect(waitingFor(workspace([first, second]), 'b', 'tiktok').map((item) => item.id)).toEqual([second.id]);
  });
});

describe('queue lanes', () => {
  it('shows what is scheduled, failed and waiting on each social with a profile', () => {
    const booked = video({ scheduled: { tiktok: { id: 'p', at: at(1, 9), state: 'scheduled' } } });
    const failed = video({ scheduled: { tiktok: { id: 'q', at: at(0, 18), state: 'failed', error: 'Too long' } } });
    const waiting = video();
    const lanes = brandLanes(workspace([booked, failed, waiting]), 'b', [status('tiktok'), status('x', false)], NOW);
    const tiktok = lanes.find((lane) => lane.platform === 'tiktok')!;
    expect(tiktok.scheduled.map((item) => item.id)).toEqual([booked.id]);
    expect(tiktok.failed.map((item) => item.id)).toEqual([failed.id]);
    expect(tiktok.waiting.map((item) => item.id)).toEqual([waiting.id]);
    expect(tiktok.lastAt).toBe(at(1, 13));
    expect(lanes.find((lane) => lane.platform === 'x')!.waiting).toHaveLength(3);
    expect(dayStart(NOW)).toBe(at(0, 0));
  });
});
