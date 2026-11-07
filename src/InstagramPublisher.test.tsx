import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstagramPublisher from './InstagramPublisher';
import * as service from './instagramService';

vi.mock('./instagramService', () => ({ instagramConnection: vi.fn(), connectInstagram: vi.fn(), disconnectInstagram: vi.fn(), publishInstagramReel: vi.fn() }));
vi.mock('./service', () => ({ openPlatformAction: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('Instagram publishing', () => {
  it('connects a professional account and publishes a Reel', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue(null);
    vi.mocked(service.connectInstagram).mockResolvedValue({ id: '123', username: 'example' });
    vi.mocked(service.publishInstagramReel).mockResolvedValue({ id: 'reel-1' });
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.type(await screen.findByLabelText('Instagram account ID'), '123');
    await user.type(screen.getByLabelText('Facebook Page access token'), 'test-token');
    await user.click(screen.getByRole('button', { name: 'Connect Instagram' }));
    expect(service.connectInstagram).toHaveBeenCalledWith('123', 'test-token');
    expect(await screen.findByText(/Connected as @example/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Public video URL'), 'https://example.com/video.mp4');
    await user.type(screen.getByLabelText('Caption optional'), 'Hello world');
    await user.click(screen.getByRole('button', { name: 'Publish Reel' }));
    expect(service.publishInstagramReel).toHaveBeenCalledWith('https://example.com/video.mp4', 'Hello world');
    expect(await screen.findByText('Your Reel was published to Instagram.')).toBeInTheDocument();
    expect(screen.getByLabelText('Public video URL')).toHaveValue('');
    expect(screen.getByLabelText('Caption optional')).toHaveValue('');
  });

  it('reports failed connection without showing a connected account', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue(null);
    vi.mocked(service.connectInstagram).mockRejectedValue(new Error('Token rejected'));
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.type(await screen.findByLabelText('Instagram account ID'), '123');
    await user.type(screen.getByLabelText('Facebook Page access token'), 'bad-token');
    await user.click(screen.getByRole('button', { name: 'Connect Instagram' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Token rejected');
    expect(screen.getByLabelText('Instagram account ID')).toHaveValue('123');
    expect(screen.queryByLabelText('Public video URL')).not.toBeInTheDocument();
  });

  it('retains the video and caption when publishing fails', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue({ id: '123', username: 'example' });
    vi.mocked(service.publishInstagramReel).mockRejectedValue(new Error('Publishing failed'));
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.type(await screen.findByLabelText('Public video URL'), 'https://example.com/video.mp4');
    await user.type(screen.getByLabelText('Caption optional'), 'Hello world');
    await user.click(screen.getByRole('button', { name: 'Publish Reel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Publishing failed');
    expect(screen.getByLabelText('Public video URL')).toHaveValue('https://example.com/video.mp4');
    expect(screen.getByLabelText('Caption optional')).toHaveValue('Hello world');
    expect(screen.getByText(/Check Instagram before retrying/)).toBeInTheDocument();
  });
});
