import { describe, expect, it } from 'vitest';
import { decided, decision, platformResults, postText, statusLabel, waiting } from './public/review.js';

const post = (fields) => ({ id: 'p', title: 'T', platforms: ['instagram', 'tiktok'], status: 'pending', submittedAt: 1, ...fields });

describe('review site', () => {
  it('queues waiting posts oldest first and lists decisions newest first', () => {
    const posts = [post({ id: 'a', submittedAt: 5 }), post({ id: 'b', submittedAt: 2 }), post({ id: 'c', status: 'rejected', decidedAt: 3 }), post({ id: 'd', status: 'posted', decidedAt: 4, postedAt: 9 })];
    expect(waiting(posts).map((item) => item.id)).toEqual(['b', 'a']);
    expect(decided(posts).map((item) => item.id)).toEqual(['d', 'c']);
  });

  it('saves only the decision fields, lower-cased and trimmed', () => {
    expect(decision('approved', 'Partner@Gmail.com', '  looks good ', 42)).toEqual({ status: 'approved', decidedBy: 'partner@gmail.com', decidedAt: 42, note: 'looks good' });
    expect(decision('rejected', 'a@b.co', undefined, 1).note).toBe('');
    expect(decision('approved', 'a@b.co', 'x'.repeat(2000), 1).note).toHaveLength(1000);
    expect(() => decision('posted', 'a@b.co', '')).toThrow();
  });

  it('shows the text as it goes out', () => {
    expect(postText({ description: ' Hi ', hashtags: ['a', 'b'] })).toBe('Hi\n\n#a #b');
    expect(postText({ hashtags: [] })).toBe('');
  });

  it('shows how each social went, with links', () => {
    const results = platformResults(post({ status: 'partly_posted', results: { instagram: { status: 'posted', url: 'https://instagram.com/p/1' }, tiktok: { status: 'failed', error: 'quota' } } }));
    expect(results).toEqual([
      { platform: 'instagram', name: 'Instagram', text: 'Posted', tone: 'good', url: 'https://instagram.com/p/1' },
      { platform: 'tiktok', name: 'TikTok', text: 'Failed: quota', tone: 'bad' },
    ]);
    expect(statusLabel(post({ status: 'partly_posted' })).tone).toBe('warn');
    expect(platformResults(post({ status: 'rejected' }))[0].text).toBe('Not posted');
  });
});
