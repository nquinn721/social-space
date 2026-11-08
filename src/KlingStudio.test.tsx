import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KlingStudio from './KlingStudio';
import * as service from './klingService';
import * as sources from './videoSourcesService';
import type { VideoSource } from './videoSourcesService';

vi.mock('./klingService', () => ({ generateKlingVideo: vi.fn(), getKlingVideo: vi.fn(), openKlingVideo: vi.fn() }));
vi.mock('./videoSourcesService', () => ({ listVideoSources: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });
afterEach(cleanup);

const source = (id: string, name: string, status: VideoSource['status'] = 'verified'): VideoSource => ({ id, name, provider: 'kling', status, checkedAt: 1, creditsRemaining: 5, detail: null });

describe('Kling Studio', () => {
  it('generates with the chosen source, checks status, and opens the video', async () => {
    vi.mocked(sources.listVideoSources).mockResolvedValue([source('a', 'Main'), source('b', 'Client'), source('c', 'Revoked', 'rejected')]);
    vi.mocked(service.generateKlingVideo).mockResolvedValue({ id: 'task-1', status: 'submitted', message: null, videoUrl: null });
    vi.mocked(service.getKlingVideo).mockResolvedValue({ id: 'task-1', status: 'succeeded', message: null, videoUrl: 'https://example.com/video.mp4' });
    const user = userEvent.setup();
    render(<KlingStudio openKling={vi.fn()} onManageSources={vi.fn()} busy={false}/>);

    const picker = await screen.findByLabelText('Video source');
    expect(screen.queryByRole('option', { name: /Revoked/ })).not.toBeInTheDocument();
    await user.selectOptions(picker, 'b');
    await user.type(screen.getByLabelText('Describe your video'), 'A bright city');
    await user.selectOptions(screen.getByLabelText('Aspect ratio'), '9:16');
    await user.selectOptions(screen.getByLabelText('Duration'), '10');
    await user.click(screen.getByRole('button', { name: 'Generate video with Kling' }));
    expect(service.generateKlingVideo).toHaveBeenCalledWith('b', 'A bright city', '9:16', 10);
    expect(await screen.findByText('Video request: submitted')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('social-manager-kling-task')!)).toEqual({ id: 'task-1', sourceId: 'b' });
    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(service.getKlingVideo).toHaveBeenCalledWith('b', 'task-1');
    await user.click(await screen.findByRole('button', { name: 'Open video' }));
    expect(service.openKlingVideo).toHaveBeenCalledWith('b', 'task-1');
  });

  it('sends people to add a source when there is no usable Kling source', async () => {
    vi.mocked(sources.listVideoSources).mockResolvedValue([source('c', 'Revoked', 'rejected')]);
    const manage = vi.fn();
    const user = userEvent.setup();
    render(<KlingStudio openKling={vi.fn()} onManageSources={manage} busy={false}/>);
    await user.click(await screen.findByRole('button', { name: 'Add a video source' }));
    expect(manage).toHaveBeenCalled();
    expect(screen.queryByLabelText('Describe your video')).not.toBeInTheDocument();
  });

  it('shows a generation error and retains the prompt', async () => {
    vi.mocked(sources.listVideoSources).mockResolvedValue([source('a', 'Main')]);
    vi.mocked(service.generateKlingVideo).mockRejectedValue(new Error('Insufficient credits'));
    const user = userEvent.setup();
    render(<KlingStudio openKling={vi.fn()} onManageSources={vi.fn()} busy={false}/>);
    await user.type(await screen.findByLabelText('Describe your video'), 'A bright city');
    await user.click(screen.getByRole('button', { name: 'Generate video with Kling' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Insufficient credits'));
    expect(screen.getByLabelText('Describe your video')).toHaveValue('A bright city');
  });
});
