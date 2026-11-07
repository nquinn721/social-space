import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KlingStudio from './KlingStudio';
import * as service from './klingService';

vi.mock('./klingService', () => ({
  klingKeyStatus: vi.fn(), saveKlingKey: vi.fn(), removeKlingKey: vi.fn(),
  generateKlingVideo: vi.fn(), getKlingVideo: vi.fn(), openKlingDeveloper: vi.fn(), openKlingVideo: vi.fn(),
}));
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });
afterEach(cleanup);

describe('Kling Studio', () => {
  it('saves a key, submits a video request, and checks its status', async () => {
    vi.mocked(service.klingKeyStatus).mockResolvedValue(false);
    vi.mocked(service.saveKlingKey).mockResolvedValue();
    vi.mocked(service.generateKlingVideo).mockResolvedValue({ id: 'task-1', status: 'submitted', message: null, videoUrl: null });
    vi.mocked(service.getKlingVideo).mockResolvedValue({ id: 'task-1', status: 'succeeded', message: null, videoUrl: 'https://example.com/video.mp4' });
    const user = userEvent.setup();
    render(<KlingStudio openKling={vi.fn()} busy={false} />);

    await user.type(await screen.findByLabelText('Kling API key'), ' test-key ');
    await user.click(screen.getByRole('button', { name: 'Save API key' }));
    expect(service.saveKlingKey).toHaveBeenCalledWith('test-key');
    expect(await screen.findByText('API key saved', { exact: false })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Describe your video'), 'A bright city');
    await user.selectOptions(screen.getByLabelText('Aspect ratio'), '9:16');
    await user.selectOptions(screen.getByLabelText('Duration'), '10');
    await user.click(screen.getByRole('button', { name: 'Generate video with Kling' }));
    expect(service.generateKlingVideo).toHaveBeenCalledWith('A bright city', '9:16', 10);
    expect(await screen.findByText('Video request: submitted')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(service.getKlingVideo).toHaveBeenCalledWith('task-1');
    await user.click(await screen.findByRole('button', { name: 'Open video' }));
    expect(service.openKlingVideo).toHaveBeenCalledWith('task-1');
  });

  it('shows a failed key save and keeps the key available for correction', async () => {
    vi.mocked(service.klingKeyStatus).mockResolvedValue(false);
    vi.mocked(service.saveKlingKey).mockRejectedValue(new Error('Credential storage unavailable'));
    const user = userEvent.setup();
    render(<KlingStudio openKling={vi.fn()} busy={false} />);
    await user.type(await screen.findByLabelText('Kling API key'), 'test-key');
    await user.click(screen.getByRole('button', { name: 'Save API key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Credential storage unavailable');
    expect(screen.getByLabelText('Kling API key')).toHaveValue('test-key');
    expect(screen.queryByLabelText('Describe your video')).not.toBeInTheDocument();
  });

  it('shows a generation error and retains the prompt', async () => {
    vi.mocked(service.klingKeyStatus).mockResolvedValue(true);
    vi.mocked(service.generateKlingVideo).mockRejectedValue(new Error('Insufficient credits'));
    const user = userEvent.setup();
    render(<KlingStudio openKling={vi.fn()} busy={false} />);
    await user.type(await screen.findByLabelText('Describe your video'), 'A bright city');
    await user.click(screen.getByRole('button', { name: 'Generate video with Kling' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Insufficient credits'));
    expect(screen.getByLabelText('Describe your video')).toHaveValue('A bright city');
  });
});

