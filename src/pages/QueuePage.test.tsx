import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Platform, Video, Workspace } from '../model';
import type { Ayrshare } from '../useAyrshare';
import QueuePage from './QueuePage';

const ayrshare = vi.hoisted(() => ({ value: {} as Partial<Ayrshare> }));
vi.mock('../useAyrshare', () => ({ useAyrshare: () => ayrshare.value }));

const account = (platform: Platform): Account => ({ id: `a-${platform}`, platform, label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b', signupEmail: 'softwings25+bunny@gmail.com' });
const video = (n: number, extra: Partial<Video> = {}): Video => ({ id: `v${n}`, brandId: 'b', categoryId: 'c', title: `Bunny ${n}`, mediaSource: `C:\\v\\${n}.mp4`, caption: 'Hi', posted: [], createdAt: n, ...extra });
const soon = Date.now() + 86_400_000;
const base: Workspace = { businessName: '', brands: [{ id: 'b', name: 'Bunny Whispers', notes: '' }], accounts: [account('tiktok')], channels: [], categories: [{ id: 'c', brandId: 'b', name: 'Snow' }],
  videos: [video(1, { scheduled: { tiktok: { id: 'p1', at: soon, state: 'scheduled' } } }), video(2, { scheduled: { tiktok: { id: 'p2', at: soon - 1000, state: 'failed', error: 'TikTok said no' } } }), video(3), video(4)] };

function connect(linked: boolean) {
  ayrshare.value = {
    status: { connected: true, working: true, xKeys: false, account: 'me', detail: null },
    inputs: () => ({ ayrshare: { connected: true, xKeys: false }, socials: { hasProfile: true, linked: linked ? [{ platform: 'tiktok', name: 'bunny', refresh: false }] : [] } }),
    auto: { running: false }, send: vi.fn(async (videoId: string, _platform: Platform, at?: number) => ({ post: { id: `new-${videoId}`, at: at ?? 0, state: 'scheduled' as const } })),
    cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}), isSending: () => false,
  };
}
beforeEach(() => connect(true));
afterEach(cleanup);

describe('post queue page', () => {
  it('shows what Ayrshare has scheduled, what failed and what waits, with cancel and retry', async () => {
    render(<QueuePage workspace={base} loaded busy={false} onSave={vi.fn(async () => true)} onOpenBrand={vi.fn()}/>);
    const lane = screen.getByRole('region', { name: 'Bunny Whispers queue' });
    expect(within(lane).getByText('1 scheduled · 2 waiting')).toBeInTheDocument();
    expect(within(lane).getByText(/Failed: TikTok said no/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(lane).getByRole('button', { name: 'Cancel Bunny 1 on TikTok' }));
    expect(ayrshare.value.cancel).toHaveBeenCalledWith('v1', 'tiktok');
    await user.click(within(lane).getByRole('button', { name: /Retry/ }));
    expect(ayrshare.value.retry).toHaveBeenCalledWith('v2', 'tiktok');
  });

  it('schedules the waiting posts in one go when automatic scheduling is off', async () => {
    const workspace = { ...base, posting: { autoSchedule: false, times: ['09:00', '13:00', '18:00'] } };
    render(<QueuePage workspace={workspace} loaded busy={false} onSave={vi.fn(async () => true)} onOpenBrand={vi.fn()}/>);
    expect(screen.getByText(/Automatic scheduling is off. 2 posts are ready to schedule/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Schedule 2 posts' }));
    expect(ayrshare.value.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ayrshare.value.send!).mock.calls.map((call) => call[0])).toEqual(['v3', 'v4']);
  });

  it('saves the switch and the posting times', async () => {
    const save = vi.fn(async () => true);
    render(<QueuePage workspace={base} loaded busy={false} onSave={save} onOpenBrand={vi.fn()}/>);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Schedule new videos by themselves'));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ posting: { autoSchedule: false, times: ['09:00', '13:00', '18:00'] } }), 'Automatic scheduling is off.');
    await user.click(screen.getByRole('button', { name: 'Remove 13:00' }));
    await user.click(screen.getByRole('button', { name: 'Save times' }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ posting: { autoSchedule: true, times: ['09:00', '18:00'] } }), expect.any(String));
  });

  it('points a social that is not linked to the brand\'s accounts', async () => {
    connect(false);
    const open = vi.fn();
    render(<QueuePage workspace={base} loaded busy={false} onSave={vi.fn(async () => true)} onOpenBrand={open}/>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Link' }));
    expect(open).toHaveBeenCalledWith('b', 'accounts');
  });
});
