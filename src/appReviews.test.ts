import { describe, expect, it } from 'vitest';
import { APP_REVIEWS, classifyReviewEmail, finishedUnseen, moveTestVideos, reviewChangesFrom, reviewOpen, reviewStatus, seenKey, testModeOf, testVideos, withPosted, withReviewState } from './appReviews';
import type { Video } from './model';

const mail = (from: string, subject: string, date: string, uid = 1) => ({ uid, from, subject, date, unread: true });

describe('app reviews', () => {
  it('reads review result emails from each social', () => {
    expect(classifyReviewEmail(mail('TikTok for Developers <noreply@developers.tiktok.com>', 'Your app review has been approved', ''))).toEqual({ provider: 'tiktok', state: 'approved' });
    expect(classifyReviewEmail(mail('TikTok for Developers <noreply@developers.tiktok.com>', 'Your app was not approved: review result', ''))).toEqual({ provider: 'tiktok', state: 'rejected' });
    expect(classifyReviewEmail(mail('TikTok <noreply@tiktok.com>', 'We received your app review submission', ''))).toEqual({ provider: 'tiktok', state: 'submitted' });
    expect(classifyReviewEmail(mail('YouTube API Services <yt-api-compliance@google.com>', 'Your audit has passed', ''))).toEqual({ provider: 'google', state: 'approved' });
    expect(classifyReviewEmail(mail('Meta for Developers <notification@facebookmail.com>', 'App Review: instagram_business_content_publish approved', ''))).toEqual({ provider: 'meta', state: 'approved' });
  });

  it('ignores mail that is not a review result', () => {
    expect(classifyReviewEmail(mail('TikTok <noreply@tiktok.com>', 'Your verification code is 123456', ''))).toBeNull();
    expect(classifyReviewEmail(mail('Someone <a@b.com>', 'Your review was approved', ''))).toBeNull();
  });

  it('keeps the newest state and ticks the setup step on approval', () => {
    let marks = withReviewState({}, 'tiktok', 'submitted', 100);
    expect(reviewStatus(marks, 'tiktok')).toEqual({ state: 'submitted', at: 100 });
    marks = withReviewState(marks, 'tiktok', 'approved', 200);
    expect(reviewStatus(marks, 'tiktok')).toEqual({ state: 'approved', at: 200 });
    expect(marks['review:tiktok:submitted']).toBeUndefined();
    expect(marks['tiktok:app:review']).toBe(200);
    expect(reviewStatus({}, 'google').state).toBe('not-submitted');
  });

  it('only applies mails newer than the current state, oldest first', () => {
    const marks = withReviewState({}, 'tiktok', 'submitted', Date.parse('2026-11-14T00:00:00Z'));
    const result = reviewChangesFrom(marks, [
      mail('TikTok <noreply@tiktok.com>', 'Your app review has been approved', 'Mon, 16 Nov 2026 10:00:00 +0000', 2),
      mail('TikTok <noreply@tiktok.com>', 'App review: changes required', 'Fri, 13 Nov 2026 10:00:00 +0000', 1),
    ]);
    expect(result?.changed.map((item) => [item.review.provider, item.state])).toEqual([['tiktok', 'approved']]);
    expect(reviewChangesFrom(result!.marks, [mail('TikTok <noreply@tiktok.com>', 'Your app review has been approved', 'Mon, 16 Nov 2026 10:00:00 +0000')])).toBeNull();
  });

  it('notices finished reviews until dismissed', () => {
    const marks = withReviewState({}, 'google', 'rejected', 500);
    expect(finishedUnseen(marks).map((item) => item.review.provider)).toEqual(['google']);
    expect(finishedUnseen({ ...marks, [seenKey('google')]: 600 })).toEqual([]);
  });
});

const video = (posted: Video['posted'] = [], testPosts?: Video['testPosts']): Video => ({ id: 'v', brandId: 'b', categoryId: 'c', title: 'Bunny', mediaSource: '', caption: '', posted, createdAt: 1, testPosts });

describe('test mode', () => {
  it('is on for TikTok and YouTube until their review is approved, never for Instagram or X', () => {
    expect(testModeOf({}, 'tiktok')?.test?.mode).toBe('Sandbox');
    expect(testModeOf({}, 'youtube')?.test?.mode).toBe('Testing');
    expect(testModeOf({}, 'instagram')).toBeNull();
    expect(testModeOf({}, 'x')).toBeNull();
    expect(testModeOf(withReviewState({}, 'tiktok', 'approved', 1), 'tiktok')).toBeNull();
  });

  it('remembers posts marked while in test mode, and forgets them when unmarked', () => {
    const posted = withPosted(video(), ['tiktok', 'instagram'], {}, 50);
    expect(posted.testPosts).toEqual({ tiktok: 50 });
    expect(withPosted(posted, ['instagram'], {}).testPosts).toBeUndefined();
    expect(withPosted(video(), ['tiktok'], withReviewState({}, 'tiktok', 'approved', 1)).testPosts).toBeUndefined();
  });

  it('moves test videos back to waiting for that social only', () => {
    const videos = [video(['tiktok', 'youtube', 'instagram'], { tiktok: 1, youtube: 2 }), { ...video(['tiktok']), id: 'w' }];
    expect(testVideos(videos, 'tiktok').map((item) => item.id)).toEqual(['v']);
    const moved = moveTestVideos(videos, 'tiktok');
    expect(moved[0].posted).toEqual(['youtube', 'instagram']);
    expect(moved[0].testPosts).toEqual({ youtube: 2 });
    expect(moved[1]).toBe(videos[1]);
  });

  it('does not wait on Meta App Review unless it was submitted', () => {
    const meta = APP_REVIEWS.find((review) => review.provider === 'meta')!;
    expect(reviewOpen({}, meta)).toBe(false);
    expect(reviewOpen(withReviewState({}, 'meta', 'submitted', 1), meta)).toBe(true);
    expect(reviewOpen({}, APP_REVIEWS[0])).toBe(true);
  });
});
