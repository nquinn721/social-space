import { describe, expect, it } from 'vitest';
import { postsToMake } from './BrandCard';
import type { SocialStatus } from './brandStatus';
import type { Workspace } from './model';

describe('posts remaining on a brand card', () => {
  it('counts posts still to make, which of them Ayrshare can post now, and the ones it already has scheduled', () => {
    const workspace: Workspace = {
      businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts: [], channels: [],
      videos: [
        { id: 'v', brandId: 'b', categoryId: 'c', title: 'Hop', mediaSource: 'video.mp4', caption: '', posted: ['facebook'], createdAt: 1 },
        { id: 'w', brandId: 'b', categoryId: 'c', title: 'Skip', mediaSource: 'video2.mp4', caption: '', posted: [], createdAt: 2, scheduled: { instagram: { id: 'p', at: 5, state: 'scheduled' } } },
      ],
    };
    const statuses: SocialStatus[] = [
      { platform: 'instagram', kind: 'ready', tone: 'ok', label: 'Ready', detail: '', canPost: true },
      { platform: 'tiktok', kind: 'not-linked', tone: 'todo', label: 'Not linked', detail: '', canPost: false },
      { platform: 'facebook', kind: 'ready', tone: 'ok', label: 'Ready', detail: '', canPost: true },
      { platform: 'youtube', kind: 'no-profile', tone: 'muted', label: 'No profile', detail: '', canPost: false },
    ];
    // v: instagram + tiktok to make; w: tiktok + facebook to make, instagram scheduled.
    expect(postsToMake(workspace, 'b', statuses)).toEqual({ total: 4, now: 2, scheduled: 1 });
  });
});
