import { describe, expect, it } from 'vitest';
import { batchPlan, preparationSignature, type BatchPlanInput } from './batchPosting';
import type { Platform, Video } from './model';
import type { SocialStatus } from './brandStatus';

const socials: Platform[] = ['instagram', 'facebook', 'tiktok', 'youtube', 'x'];
const video: Video = { id: 'v1', brandId: 'brand', categoryId: 'cat', title: 'Clip', mediaSource: 'C:\\clip.mp4', caption: '', posted: ['facebook'], createdAt: 1 };
const status = (platform: Platform, canPost = true): SocialStatus => ({ platform, canPost, via: 'browser', kind: 'ready', tone: 'ok', label: 'Ready', detail: 'Not ready', account: { id: platform, brandId: 'brand', platform, status: 'active', label: 'Brand', handle: 'brand', notes: '' } });
const base = (): BatchPlanInput => ({ video, socials, statuses: socials.map(platform => status(platform)), instagramReady: true, facebookReady: true, browserAvailable: true, isOpen: () => false, isAsking: () => false, waitingOn: () => null });

describe('posting window plan', () => {
  it('opens Instagram and Facebook like the other upload pages and distinguishes already posted and manual destinations', () => {
    const plan = batchPlan(base());
    expect(plan.map(({ platform, method }) => [platform, method])).toEqual([['instagram', 'browser'], ['facebook', 'posted'], ['tiktok', 'browser'], ['youtube', 'browser'], ['x', 'manual']]);
  });
  it('blocks open windows, pending confirmation, account failures and earlier series parts', () => {
    const input = base();
    input.isOpen = platform => platform === 'tiktok';
    input.isAsking = platform => platform === 'youtube';
    input.waitingOn = platform => platform === 'x' ? 'Post part one first' : null;
    input.video = { ...video, posted: [] };
    input.statuses = socials.map(platform => status(platform, platform !== 'instagram' && platform !== 'facebook'));
    expect(batchPlan(input).every(destination => destination.method === 'blocked')).toBe(true);
  });
  it('requires a browser and active account before offering a handoff', () => {
    const input = base();
    input.browserAvailable = false;
    expect(batchPlan(input).find(item => item.platform === 'tiktok')?.method).toBe('blocked');
    input.browserAvailable = true;
    input.statuses = input.statuses.map(item => item.platform === 'tiktok' ? { ...item, account: undefined } : item);
    expect(batchPlan(input).find(item => item.platform === 'tiktok')?.method).toBe('blocked');
  });
  it('detects changed brand, media, caption and series while ignoring posted status', () => {
    for (const changed of [{ brandId: 'other' }, { mediaSource: 'other.mp4' }, { caption: 'changed' }, { episode: 2 }]) expect(preparationSignature({ ...video, ...changed })).not.toBe(preparationSignature(video));
    expect(preparationSignature({ ...video, posted: [] })).toBe(preparationSignature(video));
  });
});
