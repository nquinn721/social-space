import { describe, expect, it } from 'vitest';
import { decided, decision, newVideoPost, newVideoProblem, parseHashtags, pick, platformResults, postText, statusLabel, waiting } from './public/review.js';

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

describe('new video form', () => {
  const catalog = { brands: [{ id: 'b1', name: 'Animals', socials: ['instagram'], categories: [{ id: 'c1', name: 'Rabbit' }] }] };
  const file = { type: 'video/mp4', size: 1000 };
  it('picks the brand and its category', () => {
    expect(pick(catalog, 'b1', 'c1').category.name).toBe('Rabbit');
    expect(pick(catalog, 'b1', 'nope').category).toBeUndefined();
  });
  it('says what is missing before uploading', () => {
    const { brand, category } = pick(catalog, 'b1', 'c1');
    const ready = { brand, category, title: 'Snow', file, platforms: ['instagram'], description: '' };
    expect(newVideoProblem(ready)).toBe('');
    expect(newVideoProblem({ ...ready, category: undefined })).toBe('Pick a category.');
    expect(newVideoProblem({ ...ready, title: '  ' })).toBe('Give the video a title.');
    expect(newVideoProblem({ ...ready, file: { type: 'image/png', size: 1 } })).toBe('That file is not a video.');
    expect(newVideoProblem({ ...ready, file: { type: 'video/webm', size: 1 } })).toBe('Use an MP4 or MOV video, the kinds every social takes.');
    expect(newVideoProblem({ ...ready, platforms: [] })).toBe('Pick at least one social.');
  });
  it('saves a post that waits for approval', () => {
    const { brand, category } = pick(catalog, 'b1', 'c1');
    const saved = newVideoPost({ id: 'abc12345', email: 'P@X.com', brand, category, title: ' Snow ', description: 'Hi', hashtags: parseHashtags('#snow, cute'), platforms: ['instagram'], madeWithAi: false, mediaPath: 'uploads/u/abc12345.mp4', mediaUrl: 'https://x', now: 5 });
    expect(saved).toMatchObject({ videoId: 'abc12345', source: 'partner', createdBy: 'p@x.com', status: 'pending', title: 'Snow', hashtags: ['snow', 'cute'], brand: 'Animals', category: 'Rabbit', submittedAt: 5 });
    expect(saved.events).toEqual([{ at: 5, text: 'Uploaded by p@x.com' }]);
  });
});
