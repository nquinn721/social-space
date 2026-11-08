import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoQueue from './VideoQueue';
import * as queue from './queueService';
import * as service from './service';
import type { Workspace } from './model';
import type { QueueInput, QueueJob } from './queueService';

vi.mock('./queueService', () => ({
  listQueue: vi.fn(), addQueueJob: vi.fn(), chooseVideoFile: vi.fn(), completeQueueJob: vi.fn(), deleteQueueJob: vi.fn(),
}));
vi.mock('./service', () => ({ openPlatformAction: vi.fn() }));

const workspace: Workspace = {
  businessName: 'Example LLC', brands: [], accounts: [],
  channels: [
    { id: 'youtube-1', platform: 'youtube', name: 'Video channel', handle: 'videos', accountId: null, notes: '' },
    { id: 'instagram-1', platform: 'instagram', name: 'Shop reels', handle: 'shop', accountId: null, notes: '' },
  ],
};
const queued = (input: QueueInput): QueueJob => ({ ...input, status: 'scheduled', error: null, instagramAccountId: null });
const makeJob = (id: string, status: QueueJob['status'], mode: QueueJob['mode']): QueueJob => ({
  id, status, mode, platform: mode === 'automatic' ? 'instagram' : 'youtube', channelId: id, channelName: id,
  channelHandle: '', mediaSource: 'https://example.com/video.mp4', caption: '', scheduledAt: Date.now() + 60000,
  error: status === 'needs_review' ? 'Check platform before retrying.' : null, instagramAccountId: null,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(queue.listQueue).mockResolvedValue([]);
  vi.mocked(queue.addQueueJob).mockImplementation(async (job) => queued(job));
  vi.mocked(queue.completeQueueJob).mockImplementation(async (id) => makeJob(id, 'posted', 'manual'));
});
afterEach(cleanup);

describe('video queue', () => {
  it('adds a manually scheduled local video from the file picker', async () => {
    const user = userEvent.setup();
    vi.mocked(queue.chooseVideoFile).mockResolvedValue('C:\\Videos\\launch.mp4');
    render(<VideoQueue workspace={workspace}/>);
    await user.selectOptions(screen.getByLabelText('Channel'), 'youtube-1');
    await user.click(screen.getByRole('button', { name: 'Choose file' }));
    expect(screen.getByLabelText('Video file or URL')).toHaveValue('C:\\Videos\\launch.mp4');
    await user.type(screen.getByLabelText('Caption optional'), 'Launching soon');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to queue' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Add to queue' }));
    expect(queue.addQueueJob).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'youtube-1', channelName: 'Video channel', channelHandle: 'videos', platform: 'youtube', mediaSource: 'C:\\Videos\\launch.mp4', caption: 'Launching soon', mode: 'manual', scheduledAt: expect.any(Number) }));
    expect(await screen.findByRole('status')).toHaveTextContent('Video added to your queue.');
    expect(screen.getByLabelText('Video file or URL')).toHaveValue('');
  });

  it('offers Instagram automatic scheduling and submits a public URL', async () => {
    const user = userEvent.setup();
    render(<VideoQueue workspace={workspace}/>);
    await user.selectOptions(screen.getByLabelText('Channel'), 'instagram-1');
    await user.type(screen.getByLabelText('Video file or URL'), 'https://media.example.com/reel.mp4');
    await user.selectOptions(screen.getByLabelText('Posting method'), 'automatic');
    expect(screen.getByText(/Keep the app running at the scheduled time/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to queue' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Add to queue' }));
    expect(queue.addQueueJob).toHaveBeenCalledWith(expect.objectContaining({ platform: 'instagram', channelId: 'instagram-1', channelHandle: 'shop', mediaSource: 'https://media.example.com/reel.mp4', mode: 'automatic' }));
  });

  it('shows a save error and retains the video details for correction', async () => {
    const user = userEvent.setup();
    vi.mocked(queue.addQueueJob).mockRejectedValue('Instagram requires a public HTTPS video URL.');
    render(<VideoQueue workspace={workspace}/>);
    await user.selectOptions(screen.getByLabelText('Channel'), 'instagram-1');
    await user.type(screen.getByLabelText('Video file or URL'), 'C:\\Videos\\not-public.mp4');
    await user.selectOptions(screen.getByLabelText('Posting method'), 'automatic');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to queue' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Add to queue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Instagram requires a public HTTPS video URL.');
    expect(screen.getByLabelText('Video file or URL')).toHaveValue('C:\\Videos\\not-public.mp4');
  });

  it('only offers completion for due or review items and opens the matching platform', async () => {
    const user = userEvent.setup();
    vi.mocked(queue.listQueue).mockResolvedValue([makeJob('Upcoming', 'scheduled', 'manual'), makeJob('Due', 'manual_due', 'manual'), makeJob('Review', 'needs_review', 'automatic'), makeJob('Finished', 'posted', 'automatic')]);
    render(<VideoQueue workspace={workspace}/>);
    const due = await screen.findByText('Due');
    const upcomingCard = screen.getByText('Upcoming').closest('article')!;
    const dueCard = due.closest('article')!;
    const reviewCard = screen.getByText('Review').closest('article')!;
    const postedCard = screen.getByText('Finished').closest('article')!;
    expect(within(upcomingCard).queryByRole('button', { name: 'Mark as posted' })).not.toBeInTheDocument();
    expect(within(postedCard).queryByRole('button', { name: 'Mark as posted' })).not.toBeInTheDocument();
    expect(within(reviewCard).getByText('Check platform before retrying.')).toBeInTheDocument();
    await user.click(within(reviewCard).getByRole('button', { name: 'Open platform' }));
    expect(service.openPlatformAction).toHaveBeenCalledWith('instagram', 'post');
    await user.click(within(dueCard).getByRole('button', { name: 'Mark as posted' }));
    await waitFor(() => expect(queue.completeQueueJob).toHaveBeenCalledWith('Due'));
    expect(await screen.findByRole('status')).toHaveTextContent('Video marked as posted.');
  });
});
