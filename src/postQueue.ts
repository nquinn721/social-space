import { PLATFORMS, type Platform, type PostingSettings, type Video, type Workspace } from './model';
import type { SocialStatus } from './brandStatus';
import { detailProblems } from './postDetails';
import { isLocalVideo } from './videoFileService';

/**
 * The post queue: every finished video of a brand waits its turn on each of the brand's socials, oldest
 * first (a series' parts in order), and goes to Ayrshare scheduled into the next free time slot: at most
 * DAILY_LIMIT a day on one account, at the times in PostingSettings. Everything here is worked out from the
 * workspace, whose post states come from Ayrshare.
 */
export const DAILY_LIMIT = 3;
export const DEFAULT_POSTING: PostingSettings = { autoSchedule: true, times: ['09:00', '13:00', '18:00'] };
/** Posts are never scheduled closer than this to now, so there is time to upload. */
export const LEAD_MS = 15 * 60_000;
/** Ayrshare keeps uploads 90 days at most; posts are scheduled at most this far ahead, the rest wait here. */
export const HORIZON_DAYS = 21;
const DAY = 86_400_000;

export function postingSettings(workspace: Workspace): PostingSettings {
  const saved = workspace.posting;
  const times = (saved?.times ?? []).filter(isTime).sort();
  return { autoSchedule: saved?.autoSchedule ?? DEFAULT_POSTING.autoSchedule, times: times.length ? [...new Set(times)].slice(0, DAILY_LIMIT) : DEFAULT_POSTING.times };
}
export const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** The socials a brand posts to (every social it has a profile on), in platform order. */
export function brandSocials(workspace: Workspace, brandId: string): Platform[] {
  return PLATFORMS.map((platform) => platform.id).filter((platform) => workspace.accounts.some((account) => account.brandId === brandId && account.platform === platform));
}

/** Local midnight of the day `now` falls in. */
export function dayStart(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
/** The local time `time` (HH:MM) on the day that starts at `day`. */
function at(day: number, time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(day);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}
const nextDay = (day: number) => dayStart(day + DAY + 3_600_000);

/** Whether a video is on its way to a social or already there: posted, or scheduled in Ayrshare. */
export function isScheduled(video: Video, platform: Platform): boolean {
  return video.scheduled?.[platform]?.state === 'scheduled';
}
export function isFailed(video: Video, platform: Platform): boolean {
  return !video.posted.includes(platform) && video.scheduled?.[platform]?.state === 'failed';
}
const taken = (video: Video, platform: Platform) => video.posted.includes(platform) || isScheduled(video, platform) || isFailed(video, platform);

/** Whether a video is finished and its post details fit every social of its brand. */
export function readyToPost(video: Video, socials: Platform[]): boolean {
  return !video.generation && isLocalVideo(video.mediaSource) && detailProblems(video, socials).length === 0;
}

/** Oldest first, except that the parts of one series keep their own order in the places that series takes. */
export function queueOrder(videos: Video[]): Video[] {
  const sorted = [...videos].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const bySeries = new Map<string, Video[]>();
  for (const video of sorted) if (video.seriesId && video.episode) bySeries.set(video.seriesId, [...(bySeries.get(video.seriesId) ?? []), video]);
  for (const parts of bySeries.values()) parts.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  const used = new Map<string, number>();
  return sorted.map((video) => {
    if (!video.seriesId || !video.episode) return video;
    const index = used.get(video.seriesId) ?? 0;
    used.set(video.seriesId, index + 1);
    return bySeries.get(video.seriesId)![index];
  });
}

/**
 * What still has to be scheduled on one social of a brand, in posting order. A series part whose earlier
 * part isn't posted or scheduled there yet can't go, and neither can anything of that series after it.
 */
export function waitingFor(workspace: Workspace, brandId: string, platform: Platform): Video[] {
  const socials = brandSocials(workspace, brandId);
  const videos = workspace.videos ?? [];
  const waiting = queueOrder(videos.filter((video) => video.brandId === brandId && !taken(video, platform) && readyToPost(video, socials)));
  const ahead = new Set<string>();
  return waiting.filter((video) => {
    if (video.seriesId && video.episode) {
      for (let number = 1; number < video.episode; number++) {
        const part = videos.find((item) => item.seriesId === video.seriesId && item.episode === number);
        if (!part || (!part.posted.includes(platform) && !isScheduled(part, platform) && !ahead.has(part.id))) return false;
      }
    }
    ahead.add(video.id);
    return true;
  });
}

/** Videos of a brand not ready for the queue yet: still being made, without a file, or with details to fix. */
export function notReady(workspace: Workspace, brandId: string): Video[] {
  const socials = brandSocials(workspace, brandId);
  return (workspace.videos ?? []).filter((video) => video.brandId === brandId && socials.some((platform) => !video.posted.includes(platform)) && !readyToPost(video, socials));
}

/** Every time a social of the brand has a post: went up (postedAt) or scheduled in Ayrshare. */
export function usedSlots(workspace: Workspace, brandId: string, platform: Platform): number[] {
  const times: number[] = [];
  for (const video of workspace.videos ?? []) {
    if (video.brandId !== brandId) continue;
    const post = video.scheduled?.[platform];
    if (post?.state === 'scheduled') times.push(post.at);
    else if (video.posted.includes(platform) && video.postedAt?.[platform] !== undefined) times.push(video.postedAt[platform]!);
  }
  return times.sort((a, b) => a - b);
}

/**
 * The next free time for a post on one account: one of the day's posting times, later than `after` and
 * than now plus LEAD_MS, on a day with fewer than DAILY_LIMIT posts, and not a time already used.
 */
export function nextSlot(used: number[], times: string[], now: number, after = 0): number {
  const from = Math.max(now + LEAD_MS, after + 1);
  for (let day = dayStart(from), tries = 0; tries < 800; day = nextDay(day), tries++) {
    const end = nextDay(day);
    const count = used.filter((time) => time >= day && time < end).length;
    if (count >= DAILY_LIMIT) continue;
    const slot = times.map((time) => at(day, time)).find((time) => time >= from && !used.includes(time));
    if (slot !== undefined) return slot;
  }
  return Infinity;
}

export type PlannedPost = { brandId: string; platform: Platform; videoId: string; at: number };
/**
 * Where each waiting video of the brand goes next on each social that can post, in order, up to
 * HORIZON_DAYS ahead. Each video takes the first free slot after everything already scheduled on that
 * social, so the queue's order holds.
 */
export function planSchedule(workspace: Workspace, brandId: string, platforms: Platform[], now = Date.now(), horizonDays = HORIZON_DAYS): PlannedPost[] {
  const { times } = postingSettings(workspace);
  const plan: PlannedPost[] = [];
  for (const platform of platforms) {
    const used = usedSlots(workspace, brandId, platform);
    let after = Math.max(0, ...(workspace.videos ?? []).filter((video) => video.brandId === brandId && isScheduled(video, platform)).map((video) => video.scheduled![platform]!.at));
    for (const video of waitingFor(workspace, brandId, platform)) {
      const slot = nextSlot(used, times, now, after);
      if (slot > now + horizonDays * DAY) break;
      plan.push({ brandId, platform, videoId: video.id, at: slot });
      used.push(slot);
      after = slot;
    }
  }
  return plan;
}

/** Posts on a social of the brand that went up today, or are scheduled for today. */
export function todayCount(workspace: Workspace, brandId: string, platform: Platform, now = Date.now()): number {
  const start = dayStart(now);
  const end = nextDay(start);
  return usedSlots(workspace, brandId, platform).filter((time) => time >= start && time < end).length;
}

export type QueueLane = {
  brandId: string; platform: Platform; status: SocialStatus;
  /** Waiting to be scheduled, in order. */
  waiting: Video[];
  /** Scheduled in Ayrshare, soonest first. */
  scheduled: Video[];
  /** Ayrshare couldn't post these; they wait for Retry. */
  failed: Video[];
  /** Posts today (up or scheduled), of DAILY_LIMIT. */
  today: number;
  /** When the last waiting video would go out at DAILY_LIMIT a day, or null when nothing waits. */
  lastAt: number | null;
};

/** Each social of a brand in the queue. */
export function brandLanes(workspace: Workspace, brandId: string, statuses: SocialStatus[], now = Date.now()): QueueLane[] {
  const videos = (workspace.videos ?? []).filter((video) => video.brandId === brandId);
  return brandSocials(workspace, brandId).map((platform) => {
    const status = statuses.find((item) => item.platform === platform)!;
    const waiting = waitingFor(workspace, brandId, platform);
    const scheduled = videos.filter((video) => isScheduled(video, platform)).sort((a, b) => a.scheduled![platform]!.at - b.scheduled![platform]!.at);
    const failed = videos.filter((video) => isFailed(video, platform));
    const plan = planSchedule(workspace, brandId, [platform], now, 3650).filter((item) => item.platform === platform);
    return { brandId, platform, status, waiting, scheduled, failed, today: todayCount(workspace, brandId, platform, now), lastAt: plan.length ? plan[plan.length - 1].at : null };
  }).filter((lane) => lane.status && lane.status.kind !== 'no-profile');
}

/** "today 1:00 PM", "tomorrow 9:00 AM", "Fri, Nov 28, 6:00 PM". */
export function whenLabel(time: number, now = Date.now()): string {
  const clock = new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((dayStart(time) - dayStart(now)) / DAY);
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  return new Date(time).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
