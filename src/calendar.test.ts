import { describe, expect, it } from 'vitest';
import type { Video, Workspace } from './model';
import { failedPosts, openSlots, postsBetween, videoPosts, weekCounts, weekDays, weekStart } from './calendar';

const NOW = new Date(2026, 10, 25, 12, 0).getTime(); // a Wednesday
const at = (dayOffset: number, hours: number) => { const day = new Date(NOW); day.setDate(day.getDate() + dayOffset); day.setHours(hours, 0, 0, 0); return day.getTime(); };
const video = (id: string, extra: Partial<Video> = {}): Video => ({ id, brandId: 'b', categoryId: 'c', title: id, mediaSource: 'x.mp4', caption: '', posted: [], createdAt: 1, ...extra });
const ws = (videos: Video[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }, { id: 'c', name: 'Goats', notes: '' }], accounts: [], channels: [], videos });

describe('calendar', () => {
  it('starts weeks on Monday and lists their 7 days', () => {
    const start = weekStart(NOW);
    expect(new Date(start).getDay()).toBe(1);
    expect(new Date(start).getDate()).toBe(23);
    expect(weekDays(start).map((day) => new Date(day).getDate())).toEqual([23, 24, 25, 26, 27, 28, 29]);
  });
  it('groups a video\'s socials going out at the same time, and keeps posted, scheduled and failed apart', () => {
    const a = video('a', { posted: ['tiktok'], postedAt: { tiktok: at(0, 9) }, scheduled: { tiktok: { id: 'p1', at: at(0, 9), state: 'posted' }, x: { id: 'p2', at: at(0, 18), state: 'scheduled' }, youtube: { id: 'p3', at: at(0, 18), state: 'scheduled' }, instagram: { id: 'p4', at: at(0, 13), state: 'failed', error: 'Too long' } } });
    expect(videoPosts(a).map((item) => `${item.platform}:${item.state}`)).toEqual(['instagram:failed', 'tiktok:posted', 'youtube:scheduled', 'x:scheduled']);
    const posts = postsBetween(ws([a, video('other', { brandId: 'c', scheduled: { x: { id: 'q', at: at(1, 9), state: 'scheduled' } } })]), weekStart(NOW), at(7, 0), 'b');
    expect(posts.map((post) => [post.state, post.platforms])).toEqual([['posted', ['tiktok']], ['failed', ['instagram']], ['scheduled', ['youtube', 'x']]]);
    expect(failedPosts(ws([a]))).toEqual([expect.objectContaining({ platform: 'instagram', error: 'Too long' })]);
  });
  it('shows posting times still ahead with nothing on them as open', () => {
    const day = at(0, 0);
    const taken = postsBetween(ws([video('a', { scheduled: { x: { id: 'p', at: at(0, 18), state: 'scheduled' } } })]), day, at(1, 0));
    expect(openSlots(ws([]), day, taken, NOW)).toEqual([at(0, 13)].filter((time) => time > NOW));
    expect(openSlots(ws([]), at(1, 0), [], NOW)).toEqual([at(1, 9), at(1, 13), at(1, 18)]);
  });
  it('counts what is scheduled in the next 7 days and posted in the last 7', () => {
    const videos = [video('a', { posted: ['x'], postedAt: { x: at(-2, 9) } }), video('b', { scheduled: { x: { id: 'p', at: at(3, 9), state: 'scheduled' }, tiktok: { id: 'q', at: at(9, 9), state: 'scheduled' } } })];
    expect(weekCounts(ws(videos), NOW)).toEqual({ scheduled: 1, posted: 1 });
  });
});
