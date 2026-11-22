import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Platform, Video, Workspace } from '../model';
import { onPostingUpdate, onSignInChange, openPostingWindow, postingSignIns, type PostingUpdate } from '../postingService';
import QueuePage from './QueuePage';

vi.mock('../postingService', () => ({ onPostingUpdate: vi.fn(), openPostingWindow: vi.fn(), postingSignIns: vi.fn(), onSignInChange: vi.fn() }));

const account = (platform: Platform): Account => ({ id: `a-${platform}`, platform, label: 'Bunny', handle: 'bunny', status: 'active', notes: '', brandId: 'b', signupEmail: 'softwings25+bunny@gmail.com' });
const video = (n: number, extra: Partial<Video> = {}): Video => ({ id: `v${n}`, brandId: 'b', categoryId: 'c', title: `Bunny ${n}`, mediaSource: `C:\\v\\${n}.mp4`, caption: 'Hi', posted: [], createdAt: n, ...extra });
const base: Workspace = { businessName: '', brands: [{ id: 'b', name: 'Bunny Whispers', notes: '' }], accounts: [account('tiktok')], channels: [], categories: [{ id: 'c', brandId: 'b', name: 'Snow' }],
  videos: [video(1, { posted: ['tiktok'], postedAt: { tiktok: Date.now() } }), video(2), video(3), video(4)] };
let update: (value: PostingUpdate) => void;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(onPostingUpdate).mockImplementation(async (handler) => { update = handler; return () => {}; });
  vi.mocked(openPostingWindow).mockResolvedValue('');
  vi.mocked(postingSignIns).mockResolvedValue({});
  vi.mocked(onSignInChange).mockResolvedValue(() => {});
});

describe('post queue page', () => {
  it('walks through today\'s posts and stops at the daily limit', async () => {
    let workspace = base;
    const save = vi.fn(async (next: Workspace) => { workspace = next; view.rerender(page()); return true; });
    const page = () => <QueuePage workspace={workspace} loaded busy={false} onSave={save} onOpenBrand={() => {}}/>;
    const view = render(page());
    expect(screen.getByText('1/3 today')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: "Post today's 2 videos" }));
    await waitFor(() => expect(openPostingWindow).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'v2', platform: 'tiktok' })));
    expect(screen.getByText('Post 1 of 2')).toBeInTheDocument();
    await act(async () => update({ videoId: 'v2', platform: 'tiktok', state: 'posted', posted: true }));
    await waitFor(() => expect(openPostingWindow).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'v3' })));
    expect(workspace.videos!.find((item) => item.id === 'v2')!.postedAt?.tiktok).toBeGreaterThan(0);
    await act(async () => update({ videoId: 'v3', platform: 'tiktok', state: 'closed', posted: false }));
    await userEvent.click(await screen.findByRole('button', { name: "Yes, it's up" }));
    await screen.findByText(/Today's posts are done/);
    expect(screen.getByText('3/3 today')).toBeInTheDocument();
    expect(openPostingWindow).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Nothing to post today' })).toBeDisabled();
  });
});
