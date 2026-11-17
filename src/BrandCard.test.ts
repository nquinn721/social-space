import { describe, expect, it } from 'vitest';
import { postsToMake } from './BrandCard';
import type { SocialStatus } from './brandStatus';
import type { Workspace } from './model';

describe('posts remaining on a brand card', () => {
  it('only counts verified API destinations as ready now, while keeping manual handoffs in the total', () => {
    const workspace: Workspace = {
      businessName: '', brands: [{ id: 'b', name: 'Bunny', notes: '' }], accounts: [], channels: [],
      videos: [{ id: 'v', brandId: 'b', categoryId: 'c', title: 'Hop', mediaSource: 'video.mp4', caption: '', posted: ['facebook'], createdAt: 1 }],
    };
    const statuses: SocialStatus[] = [
      { platform: 'instagram', kind: 'ready', tone: 'ok', label: 'Ready', detail: '', canPost: true, via: 'api' },
      { platform: 'tiktok', kind: 'verify-session', tone: 'todo', label: 'Not checked', detail: '', canPost: true, via: 'browser' },
      { platform: 'facebook', kind: 'ready', tone: 'ok', label: 'Ready', detail: '', canPost: true, via: 'api' },
      { platform: 'youtube', kind: 'no-profile', tone: 'muted', label: 'No profile', detail: '', canPost: false, via: 'browser' },
    ];
    expect(postsToMake(workspace, 'b', statuses)).toEqual({ total: 2, now: 1 });
  });
});
