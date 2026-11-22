import { PLATFORMS, type Platform, type Video, type Workspace } from './model';
import type { SocialStatus } from './brandStatus';
import { detailProblems } from './postDetails';
import { isLocalVideo } from './videoFileService';

/**
 * The post queue: every finished video of a brand waits its turn on each of the brand's socials, oldest
 * first (a series' parts in order), and at most DAILY_LIMIT go up on one account in a day. When a social
 * is posted to is read from Video.postedAt, so the queue, the daily count and the walk-through all come
 * from the workspace and nothing else.
 */
export const DAILY_LIMIT = 3;

/** The socials a brand posts to, in platform order (the same list as the video library's). */
function brandSocials(workspace: Workspace, brandId: string): Platform[] {
  return PLATFORMS.map((platform) => platform.id).filter((platform) => workspace.accounts.some((account) => account.brandId === brandId && account.platform === platform));
}

/** Local midnight of the day `now` falls in. */
export function dayStart(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Videos of a brand that went up on a social today. Posts recorded before postedAt existed don't count. */
export function postedToday(workspace: Workspace, brandId: string, platform: Platform, now = Date.now()): Video[] {
  const start = dayStart(now);
  const end = start + 86_400_000;
  return (workspace.videos ?? []).filter((video) => {
    const at = video.postedAt?.[platform];
    return video.brandId === brandId && video.posted.includes(platform) && at !== undefined && at >= start && at < end;
  });
}

/** How many more posts the account may take today. */
export function leftToday(workspace: Workspace, brandId: string, platform: Platform, now = Date.now()): number {
  return Math.max(0, DAILY_LIMIT - postedToday(workspace, brandId, platform, now).length);
}

/** Why a social can't take another post today, or null when it can. */
export function dailyLimitReason(workspace: Workspace, brandId: string, platform: Platform, now = Date.now()): string | null {
  return leftToday(workspace, brandId, platform, now) > 0 ? null : `${DAILY_LIMIT} posts went up on this account today, the most it takes in a day. The next one can go tomorrow.`;
}

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
  const taken = new Map<string, number>();
  return sorted.map((video) => {
    if (!video.seriesId || !video.episode) return video;
    const index = taken.get(video.seriesId) ?? 0;
    taken.set(video.seriesId, index + 1);
    return bySeries.get(video.seriesId)![index];
  });
}

/**
 * What waits for one social of a brand, in posting order. A series part whose earlier part has no
 * postable video yet can't go, and neither can anything of that series after it.
 */
export function waitingFor(workspace: Workspace, brandId: string, platform: Platform): Video[] {
  const socials = brandSocials(workspace, brandId);
  const videos = workspace.videos ?? [];
  const waiting = queueOrder(videos.filter((video) => video.brandId === brandId && !video.posted.includes(platform) && readyToPost(video, socials)));
  const ahead = new Set<string>();
  return waiting.filter((video) => {
    if (video.seriesId && video.episode) {
      for (let number = 1; number < video.episode; number++) {
        const part = videos.find((item) => item.seriesId === video.seriesId && item.episode === number);
        if (!part || (!part.posted.includes(platform) && !ahead.has(part.id))) return false;
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

export type QueueLane = {
  brandId: string; platform: Platform; status: SocialStatus;
  /** Everything waiting, in order. */
  waiting: Video[];
  /** Posted today, oldest first. */
  today: Video[];
  /** What goes up today: the first of waiting, as many as the account still takes today. Empty when it can't post. */
  due: Video[];
  /** The day everything waiting is up, at DAILY_LIMIT a day: 0 is today, 1 tomorrow. Null when nothing waits. */
  doneIn: number | null;
};

/** Each social of a brand in the queue. */
export function brandLanes(workspace: Workspace, brandId: string, statuses: SocialStatus[], now = Date.now()): QueueLane[] {
  return brandSocials(workspace, brandId).map((platform) => {
    const status = statuses.find((item) => item.platform === platform)!;
    const waiting = waitingFor(workspace, brandId, platform);
    const today = postedToday(workspace, brandId, platform, now).sort((a, b) => (a.postedAt?.[platform] ?? 0) - (b.postedAt?.[platform] ?? 0));
    const left = Math.max(0, DAILY_LIMIT - today.length);
    const due = status?.canPost ? waiting.slice(0, left) : [];
    return { brandId, platform, status, waiting, today, due, doneIn: finishDay(waiting.length, left) };
  }).filter((lane) => lane.status && lane.status.kind !== 'no-profile');
}

/** The day the last of `count` waiting posts goes up when today still takes `left`: 0 is today. */
export function finishDay(count: number, left: number): number | null {
  if (count === 0) return null;
  return count <= left ? 0 : Math.ceil((count - left) / DAILY_LIMIT);
}

/** "today", "tomorrow", "in 5 days". */
export function dayLabel(offset: number): string {
  return offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : `in ${offset} days`;
}

export type QueueStep = { brandId: string; platform: Platform; videoId: string };
export const stepKey = (step: QueueStep) => `${step.videoId}:${step.platform}`;

/** Today's posts, one account at a time: a brand's socials in turn, each with its due videos in order. */
export function todaysSteps(lanes: QueueLane[]): QueueStep[] {
  return lanes.flatMap((lane) => lane.due.map((video) => ({ brandId: lane.brandId, platform: lane.platform, videoId: video.id })));
}
