import { describe, expect, it } from 'vitest';
import { withReviewState } from './appReviews';
import { postMode, postModeNote } from './postingMode';
import { brandLogin, markPosted, postRequest, wrongLogin } from './useBrowserPosting';
import type { Workspace } from './model';

describe('posting mode', () => {
  it('posts Instagram through the API and the others through their page', () => {
    expect(postMode('instagram')).toBe('api');
    expect(postMode('tiktok')).toBe('browser');
    expect(postMode('youtube')).toBe('browser');
    expect(postMode('x')).toBe('browser');
  });
  it('says when a review is approved', () => {
    expect(postModeNote(undefined, 'tiktok')).toMatch(/until the app review is approved/);
    expect(postModeNote(withReviewState(undefined, 'tiktok', 'approved'), 'tiktok')).toMatch(/approved/);
    expect(postModeNote(undefined, 'x')).toMatch(/you press Post/);
  });
});

const workspace: Workspace = {
  businessName: '', brands: [{ id: 'b1', name: 'Animals', notes: '' }], channels: [],
  accounts: [{ id: 'a1', platform: 'tiktok', label: 'Animals', handle: 'animals', status: 'active', notes: '', brandId: 'b1', signupEmail: 'x+animals@example.com' }],
  videos: [{ id: 'v1', brandId: 'b1', categoryId: 'c1', title: 'Bunny', mediaSource: 'C:\\v\\bunny.mp4', caption: 'Hop', posted: [], createdAt: 1,
    details: { hashtags: ['bunny'], youtubeTitle: 'Bunny hops', coverMs: 3200, madeWithAi: true, shareToFeed: true, madeForKids: false } }],
};

describe('browser posting', () => {
  it('fills the upload page from the brand profile and the post details', () => {
    expect(postRequest(workspace, workspace.videos![0], 'tiktok')).toEqual({
      platform: 'tiktok', brandId: 'b1', videoId: 'v1', accountId: 'a1', handle: 'animals', email: 'x+animals@example.com',
      videoPath: 'C:\\v\\bunny.mp4', title: 'Bunny hops', text: 'Hop\n\n#bunny', madeWithAi: true, madeForKids: false, cover: '0:03.2', coverMs: 3200,
    });
    expect(postRequest(workspace, workspace.videos![0], 'youtube').accountId).toBeUndefined();
  });
  it('never fills the main Gmail or a developer login', () => {
    const account = workspace.accounts[0];
    expect(brandLogin(undefined, { ...account, signupEmail: 'softwings25@gmail.com' })).toEqual({ accountId: undefined, email: '' });
    expect(brandLogin({ tiktok: { email: 'dev@example.com' } }, { ...account, signupEmail: 'Dev@example.com' })).toEqual({ accountId: undefined, email: '' });
    expect(brandLogin(undefined, account)).toEqual({ accountId: 'a1', email: 'x+animals@example.com' });
  });
  it('blocks only TikTok and X profiles saved with the main Gmail; YouTube channels may live under it', () => {
    const account = workspace.accounts[0];
    expect(wrongLogin(undefined, { ...account, signupEmail: 'softwings25@gmail.com' })).toBe(true);
    expect(wrongLogin(undefined, { ...account, platform: 'youtube', signupEmail: 'softwings25@gmail.com' })).toBe(false);
    expect(brandLogin(undefined, { ...account, platform: 'youtube', signupEmail: 'softwings25@gmail.com' }).email).toBe('');
  });
  it('marks a video posted once', () => {
    const next = markPosted(workspace, 'v1', 'tiktok')!;
    expect(next.videos![0].posted).toEqual(['tiktok']);
    expect(markPosted(next, 'v1', 'tiktok')).toBeNull();
    expect(markPosted(workspace, 'nope', 'tiktok')).toBeNull();
  });
  it('counts a post made on the page as real even while the API is in test mode', () => {
    const next = markPosted(workspace, 'v1', 'tiktok')!;
    expect(next.videos![0].testPosts).toBeUndefined();
  });
});
