import { PLATFORMS, type Platform, type Video, type Workspace } from './model';
import { DAILY_LIMIT, dayStart, postingSettings } from './postQueue';

const DAY = 86_400_000;
const ORDER = PLATFORMS.map((platform) => platform.id);

export type PostState = 'scheduled' | 'posted' | 'failed';
/** One video going out at one time, on one or more socials of its brand. */
export type CalendarPost = { key: string; videoId: string; brandId: string; title: string; at: number; platforms: Platform[]; state: PostState };

/** Where and when one video is on each social: scheduled, posted or failed, with its time. */
export function videoPosts(video: Video): { platform: Platform; at: number; state: PostState; error?: string }[] {
  const out: { platform: Platform; at: number; state: PostState; error?: string }[] = [];
  for (const platform of ORDER) {
    const post = video.scheduled?.[platform];
    if (video.posted.includes(platform)) {
      const at = video.postedAt?.[platform] ?? post?.at;
      if (at !== undefined) out.push({ platform, at, state: 'posted' });
    } else if (post) out.push({ platform, at: post.at, state: post.state === 'posted' ? 'posted' : post.state, error: post.error });
  }
  return out;
}

/**
 * Every post between `from` and `to` (end excluded), for one brand or all. Posts of a video at the same minute
 * with the same state are one entry with several socials, the way the calendar shows them.
 */
export function postsBetween(workspace: Workspace, from: number, to: number, brandId?: string): CalendarPost[] {
  const posts = new Map<string, CalendarPost>();
  for (const video of workspace.videos ?? []) {
    if (brandId && video.brandId !== brandId) continue;
    for (const item of videoPosts(video)) {
      if (item.at < from || item.at >= to) continue;
      const minute = Math.floor(item.at / 60_000);
      const key = `${video.id}:${minute}:${item.state}`;
      const found = posts.get(key);
      if (found) found.platforms.push(item.platform);
      else posts.set(key, { key, videoId: video.id, brandId: video.brandId, title: video.title, at: item.at, platforms: [item.platform], state: item.state });
    }
  }
  return [...posts.values()].sort((a, b) => a.at - b.at || a.title.localeCompare(b.title));
}

/** Monday 00:00 of the week `time` is in, on this PC's clock. */
export function weekStart(time: number): number {
  const day = new Date(dayStart(time));
  const back = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - back);
  return day.getTime();
}

/** The 7 days of the week starting at `start` (each a local midnight, safe across clock changes). */
export function weekDays(start: number): number[] {
  return Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(day.getDate() + index); return day.getTime(); });
}

/** The time `HH:MM` on `day`. */
export function atTime(day: number, time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(day);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

/** Posting times on `day` that are still ahead and have nothing going out at them yet. */
export function openSlots(workspace: Workspace, day: number, posts: CalendarPost[], now: number): number[] {
  const times = postingSettings(workspace).times.slice(0, DAILY_LIMIT);
  const taken = new Set(posts.filter((post) => post.state !== 'failed').map((post) => Math.floor(post.at / 60_000)));
  return times.map((time) => atTime(day, time)).filter((at) => at > now && !taken.has(Math.floor(at / 60_000)));
}

/** Counts for the Today page: scheduled in the next 7 days, and posted in the last 7. */
export function weekCounts(workspace: Workspace, now: number) {
  let scheduled = 0; let posted = 0;
  for (const video of workspace.videos ?? []) {
    for (const item of videoPosts(video)) {
      if (item.state === 'scheduled' && item.at >= now && item.at < now + 7 * DAY) scheduled += 1;
      if (item.state === 'posted' && item.at <= now && item.at > now - 7 * DAY) posted += 1;
    }
  }
  return { scheduled, posted };
}

/** Each failed post, newest first, so it can be retried. */
export function failedPosts(workspace: Workspace, brandId?: string) {
  return (workspace.videos ?? []).flatMap((video) => (brandId && video.brandId !== brandId) ? [] : videoPosts(video).filter((item) => item.state === 'failed').map((item) => ({ video, ...item })))
    .sort((a, b) => b.at - a.at);
}

/** "Monday 23 November" style headings and short times, on this PC's clock. */
export const dayLabel = (day: number) => new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
export const shortDay = (day: number) => new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
export const timeLabel = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
