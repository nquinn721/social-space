import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoStudio from './VideoStudio';
import * as service from './videoSourcesService';
import type { VideoSource } from './videoSourcesService';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('./videoSourcesService', () => ({
  DESKTOP_ONLY: 'Open the desktop app to manage video sources.',
  listVideoSources: vi.fn(), setActiveVideoSource: vi.fn(), generateVideo: vi.fn(), getVideo: vi.fn(), openVideo: vi.fn(), openProviderSite: vi.fn(),
}));
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });
afterEach(cleanup);

const source = (id: string, name: string, provider: VideoSource['provider'], status: VideoSource['status'] = 'verified'): VideoSource => ({ id, name, provider, status, checkedAt: 1, creditsRemaining: null, detail: null });
const sources = [source('k', 'Kling main', 'kling'), source('g', 'Grok', 'grok'), source('x', 'Revoked', 'kling', 'rejected')];

describe('Video studio', () => {
  it('generates with the active source, switches to Grok, and follows the request', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValue({ active: 'k', sources });
    vi.mocked(service.setActiveVideoSource).mockResolvedValue({ active: 'g', sources });
    vi.mocked(service.generateVideo).mockResolvedValue({ id: 'r1', status: 'pending', message: null, videoUrl: null, sourceId: 'g', sourceName: 'Grok', provider: 'grok' });
    vi.mocked(service.getVideo).mockResolvedValue({ id: 'r1', status: 'done', message: null, videoUrl: 'https://vidgen.x.ai/a.mp4' });
    const user = userEvent.setup();
    render(<VideoStudio onManageSources={vi.fn()}/>);

    const picker = await screen.findByLabelText('Video source');
    expect(screen.getByRole('heading', { name: 'Kling AI' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Revoked/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /seconds/ }).map((option) => option.textContent)).toEqual(['5 seconds', '10 seconds']);

    await user.selectOptions(picker, 'g');
    expect(service.setActiveVideoSource).toHaveBeenCalledWith('g');
    expect(await screen.findByRole('heading', { name: 'Grok Imagine' })).toBeInTheDocument();
    expect(screen.getByLabelText('Duration')).toHaveValue('8');

    await user.type(screen.getByLabelText('Describe your video'), 'A bright city');
    await user.selectOptions(screen.getByLabelText('Aspect ratio'), '9:16');
    await user.click(screen.getByRole('button', { name: 'Generate with Grok' }));
    expect(service.generateVideo).toHaveBeenCalledWith('g', 'A bright city', '9:16', 8);
    expect(await screen.findByText('Video request: pending')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('social-manager-video-task')!)).toEqual({ id: 'r1', sourceId: 'g', sourceName: 'Grok', provider: 'grok' });

    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(service.getVideo).toHaveBeenCalledWith('g', 'r1');
    await user.click(await screen.findByRole('button', { name: 'Open video' }));
    expect(service.openVideo).toHaveBeenCalledWith('g', 'r1');
  });

  it('sends people to add a source when none is usable', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValue({ active: null, sources: [source('x', 'Revoked', 'kling', 'rejected')] });
    const manage = vi.fn();
    const user = userEvent.setup();
    render(<VideoStudio onManageSources={manage}/>);
    await user.click(await screen.findByRole('button', { name: 'Add a video source' }));
    expect(manage).toHaveBeenCalled();
    expect(screen.queryByLabelText('Describe your video')).not.toBeInTheDocument();
  });

  it('shows a generation error and keeps the prompt', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValue({ active: 'k', sources });
    vi.mocked(service.generateVideo).mockRejectedValue('Insufficient credits');
    const user = userEvent.setup();
    render(<VideoStudio onManageSources={vi.fn()}/>);
    await user.type(await screen.findByLabelText('Describe your video'), 'A bright city');
    await user.click(screen.getByRole('button', { name: 'Generate with Kling main' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Insufficient credits'));
    expect(screen.getByLabelText('Describe your video')).toHaveValue('A bright city');
  });
});
