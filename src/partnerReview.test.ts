import { describe, expect, it } from 'vitest';
import type { Video, Workspace } from './model';
import { approvedToPost, approvedVideo, canSend, finishedStatus, partnerVideo, partnerVideosToImport, resultEvent, reviewCatalog, reviewLabel, submissionFor } from './partnerReview';
import type { ReviewPost } from './reviewService';

const video: Video = {
  id: 'v1', brandId: 'b1', categoryId: 'c1', title: 'Bunny hop', mediaSource: 'C:\\videos\\bunny.mp4', caption: ' Hop hop ', posted: ['tiktok'], createdAt: 1,
  details: { hashtags: ['bunny'], youtubeTitle: 'Bunny hop!', coverMs: 1500, madeWithAi: true, shareToFeed: true, madeForKids: false },
};
const workspace: Workspace = { businessName: '', brands: [{ id: 'b1', name: 'Animals', notes: '' }], accounts: [], channels: [], categories: [{ id: 'c1', brandId: 'b1', name: 'Rabbit' }], videos: [video] };
const post = (fields: Partial<ReviewPost>): ReviewPost => ({
  id: 'v1', videoId: 'v1', title: 'Bunny hop', brand: 'Animals', category: 'Rabbit', youtubeTitle: '', description: '', hashtags: [], platforms: ['instagram'],
  madeWithAi: false, status: 'pending', submittedAt: 1, ...fields,
});

describe('partner review', () => {
  it('sends the post as it will go out, only to the socials it is not on yet', () => {
    expect(submissionFor(video, workspace, ['instagram', 'tiktok', 'youtube'])).toEqual({
      videoId: 'v1', title: 'Bunny hop', brand: 'Animals', category: 'Rabbit', youtubeTitle: 'Bunny hop!', description: 'Hop hop',
      hashtags: ['bunny'], platforms: ['instagram', 'youtube'], madeWithAi: true, coverMs: 1500, mediaSource: 'C:\\videos\\bunny.mp4',
    });
  });

  it('posts the text the reviewer approved, not later edits', () => {
    const edited = { ...video, caption: 'Changed after sending' };
    const ready = approvedVideo(edited, post({ description: 'Approved text', hashtags: ['ok'], youtubeTitle: 'Approved title' }));
    expect(ready.caption).toBe('Approved text');
    expect(ready.details?.hashtags).toEqual(['ok']);
    expect(ready.details?.youtubeTitle).toBe('Approved title');
    expect(ready.mediaSource).toBe(video.mediaSource);
  });

  it('works out the overall result from each social', () => {
    expect(finishedStatus(['instagram', 'tiktok'], { instagram: { status: 'posted', at: 1 }, tiktok: { status: 'manual', at: 1 } })).toBe('posted');
    expect(finishedStatus(['instagram', 'youtube'], { instagram: { status: 'posted', at: 1 }, youtube: { status: 'failed', at: 1 } })).toBe('partly_posted');
    expect(finishedStatus(['instagram'], { instagram: { status: 'failed', error: 'no', at: 1 } })).toBe('failed');
    expect(finishedStatus(['instagram'], {})).toBe('failed');
  });

  it('writes a history line for each social', () => {
    expect(resultEvent('instagram', { status: 'posted', at: 5 })).toEqual({ at: 5, text: 'Posted to Instagram' });
    expect(resultEvent('tiktok', { status: 'manual', at: 5 }).text).toBe('TikTok is posted by hand from Social Space');
    expect(resultEvent('youtube', { status: 'failed', error: 'quota', at: 5 }).text).toBe('YouTube failed: quota');
  });

  it('posts approved posts oldest decision first and nothing else', () => {
    const list = [post({ id: 'a', status: 'approved', decidedAt: 9 }), post({ id: 'b', status: 'pending' }), post({ id: 'c', status: 'approved', decidedAt: 3 }), post({ id: 'd', status: 'posted' })];
    expect(approvedToPost(list).map((item) => item.id)).toEqual(['c', 'a']);
  });

  it('labels the review on a video and only lets undecided posts be sent again', () => {
    expect(reviewLabel(undefined)).toBeNull();
    expect(reviewLabel(post({ status: 'rejected', decidedBy: 'p@x.com', note: 'too dark' }))).toEqual({ text: 'Rejected by p@x.com: too dark', tone: 'bad' });
    expect(reviewLabel(post({ status: 'posted', decidedBy: 'p@x.com' }))?.tone).toBe('good');
    expect(canSend(undefined)).toBe(true);
    expect(canSend(post({ status: 'rejected' }))).toBe(true);
    expect(canSend(post({ status: 'approved' }))).toBe(false);
    expect(canSend(post({ status: 'posted' }))).toBe(false);
  });
});

describe('videos the partner makes on the site', () => {
  const made = (fields: Partial<ReviewPost>) => post({ source: 'partner', brandId: 'b1', categoryId: 'c1', mediaPath: 'uploads/u/p.mp4', ...fields });
  it('offers each brand with its socials and categories', () => {
    const withAccounts = { ...workspace, accounts: [{ id: 'a', platform: 'youtube' as const, label: '', handle: '', status: 'active' as const, notes: '', brandId: 'b1' }, { id: 'b', platform: 'instagram' as const, label: '', handle: '', status: 'planned' as const, notes: '', brandId: 'b1' }],
      categories: [{ id: 'c1', brandId: 'b1', name: 'Rabbit', defaults: { caption: 'Hi', hashtags: ['bunny'] } }] };
    expect(reviewCatalog(withAccounts)).toEqual([{ id: 'b1', name: 'Animals', socials: ['instagram', 'youtube'], categories: [{ id: 'c1', name: 'Rabbit', defaults: { caption: 'Hi', hashtags: ['bunny'] } }] }]);
  });
  it('imports only new partner videos whose category still exists', () => {
    const list = [made({ id: 'n', videoId: 'n' }), made({ id: 'v1', videoId: 'v1' }), made({ id: 'gone', videoId: 'gone', categoryId: 'deleted' }), post({ id: 'app', videoId: 'app' })];
    expect(partnerVideosToImport(list, workspace).map((item) => item.id)).toEqual(['n']);
  });
  it('turns the upload into a library video waiting for approval', () => {
    expect(partnerVideo(made({ videoId: 'n', title: 'Snow', description: 'Fresh', hashtags: ['snow'], madeWithAi: true }), 'C:\\v\\Snow.mp4', 7)).toEqual({
      id: 'n', brandId: 'b1', categoryId: 'c1', title: 'Snow', mediaSource: 'C:\\v\\Snow.mp4', caption: 'Fresh', posted: [], createdAt: 7,
      details: { hashtags: ['snow'], youtubeTitle: 'Snow', madeWithAi: true, shareToFeed: true, madeForKids: false },
    });
  });
});
