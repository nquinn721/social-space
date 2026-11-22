import type { Platform, Video } from './model';
import type { SocialStatus } from './brandStatus';
import { postMode } from './postingMode';

export type BatchMethod = 'browser' | 'manual' | 'blocked' | 'posted';
export type BatchDestination = { platform: Platform; method: BatchMethod; reason: string; accountId?: string; accountSnapshot?: string };
export type BatchPlanInput = {
  video: Video; socials: Platform[]; statuses: SocialStatus[];
  instagramReady: boolean; facebookReady: boolean; browserAvailable: boolean;
  isOpen: (platform: Platform) => boolean; isAsking: (platform: Platform) => boolean;
  waitingOn: (platform: Platform) => string | null;
};

/** The plan never treats a browser window or an uncertain result as a published post. */
export function batchPlan(input: BatchPlanInput): BatchDestination[] {
  return input.socials.map((platform) => {
    const status = input.statuses.find((candidate) => candidate.platform === platform);
    const item = (method: BatchMethod, reason: string): BatchDestination => ({ platform, method, reason, accountId: status?.account?.id, accountSnapshot: status?.account ? JSON.stringify(status.account) : undefined });
    if (input.video.posted.includes(platform)) return item('posted', 'Already posted');
    const waiting = input.waitingOn(platform);
    if (waiting) return item('blocked', waiting);
    if (input.isAsking(platform)) return item('blocked', 'Confirm whether the earlier post went up first');
    if (input.isOpen(platform)) return item('blocked', 'Posting window is already open');
    if (!status?.canPost) return item('blocked', status?.detail ?? 'Account status is unavailable');
    if (platform === 'instagram' && postMode(platform) === 'api') return item('blocked', input.instagramReady ? 'Use the separate Instagram Post button after reviewing the account' : 'Instagram connection or video is not ready');
    if (platform === 'facebook' && postMode(platform) === 'api') return item('blocked', input.facebookReady ? 'Use the separate Facebook Post button after reviewing the Page' : 'Facebook Page or video is not ready');
    if (!input.browserAvailable) return item('blocked', 'Posting window is unavailable');
    if (!status.account?.id) return item('blocked', 'Choose an active brand account first');
    if (platform === 'x') return item('manual', 'Opens X; you attach the video, paste the caption, and post');
    return item('browser', 'Opens the upload page; you review and publish');
  });
}


/** Details approved when opening the platform windows. Posted status is checked separately. */
export function preparationSignature(video: Video): string {
  const { id, brandId, categoryId, title, mediaSource, caption, details, seriesId, episode } = video;
  return JSON.stringify({ id, brandId, categoryId, title, mediaSource, caption, details, seriesId, episode });
}
