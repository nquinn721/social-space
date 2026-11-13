import { describe, expect, it } from 'vitest';
import { classifyReviewEmail, finishedUnseen, reviewChangesFrom, reviewStatus, seenKey, withReviewState } from './appReviews';

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
