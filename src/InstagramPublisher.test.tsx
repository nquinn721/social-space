import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstagramPublisher from './InstagramPublisher';
import * as service from './instagramService';

vi.mock('./instagramService', () => ({ instagramConnection: vi.fn(), connectInstagram: vi.fn(), disconnectInstagram: vi.fn(), publishInstagramReel: vi.fn(), publishInstagramPhoto: vi.fn(), publishInstagramReelFile: vi.fn(), chooseInstagramVideo: vi.fn() }));
vi.mock('./service', () => ({ openPlatformAction: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('Instagram publishing', () => {
  it('shows the setup steps and connects with just an Instagram token', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue(null);
    vi.mocked(service.connectInstagram).mockResolvedValue({ id: '123', username: 'example', login: 'instagram' });
    vi.mocked(service.publishInstagramPhoto).mockResolvedValue({ id: 'post-1' });
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    expect(await screen.findByText(/Switch to professional account/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Access token'), 'IGtest-token');
    await user.click(screen.getByRole('button', { name: 'Connect Instagram' }));
    expect(service.connectInstagram).toHaveBeenCalledWith('', 'IGtest-token', undefined);
    expect(await screen.findByText(/Connected as @example with an Instagram token/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Public link to a JPEG photo'), 'https://example.com/photo.jpg');
    await user.type(screen.getByLabelText('Caption optional'), 'Hello world');
    await user.click(screen.getByRole('button', { name: 'Publish photo' }));
    expect(service.publishInstagramPhoto).toHaveBeenCalledWith('https://example.com/photo.jpg', 'Hello world', undefined);
    expect(await screen.findByText('Your photo was published to Instagram.')).toBeInTheDocument();
    expect(screen.getByLabelText('Caption optional')).toHaveValue('');
  });

  it('publishes a Reel from a link', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue({ id: '123', username: 'example', login: 'facebook' });
    vi.mocked(service.publishInstagramReel).mockResolvedValue({ id: 'reel-1' });
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.click(await screen.findByRole('button', { name: 'Reel from a link' }));
    await user.type(screen.getByLabelText('Public video URL'), 'https://example.com/video.mp4');
    await user.click(screen.getByRole('button', { name: 'Publish Reel' }));
    expect(service.publishInstagramReel).toHaveBeenCalledWith('https://example.com/video.mp4', '', undefined);
    expect(await screen.findByText('Your Reel was published to Instagram.')).toBeInTheDocument();
  });

  it('uploads a Reel from this PC with a Facebook Page token', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue({ id: '123', username: 'example', login: 'facebook' });
    vi.mocked(service.chooseInstagramVideo).mockResolvedValue('C:\\videos\\test.mp4');
    vi.mocked(service.publishInstagramReelFile).mockResolvedValue({ id: 'reel-2' });
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.click(await screen.findByRole('button', { name: 'Reel from this PC' }));
    await user.click(screen.getByRole('button', { name: 'Choose video' }));
    expect(await screen.findByDisplayValue('C:\\videos\\test.mp4')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish Reel' }));
    expect(service.publishInstagramReelFile).toHaveBeenCalledWith('C:\\videos\\test.mp4', '', undefined);
    expect(await screen.findByText('Your Reel was uploaded and published to Instagram.')).toBeInTheDocument();
  });

  it('explains that file uploads need a Page token when connected with an Instagram token', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue({ id: '123', username: 'example', login: 'instagram' });
    vi.mocked(service.chooseInstagramVideo).mockResolvedValue('C:\\videos\\test.mp4');
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.click(await screen.findByRole('button', { name: 'Reel from this PC' }));
    await user.click(screen.getByRole('button', { name: 'Choose video' }));
    expect(await screen.findByText(/needs a Facebook Page token/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish Reel' })).toBeDisabled();
  });

  it('reports failed connection without showing a connected account', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue(null);
    vi.mocked(service.connectInstagram).mockRejectedValue(new Error('Token rejected'));
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.type(await screen.findByLabelText('Instagram account ID only for Facebook Page tokens'), '123');
    await user.type(screen.getByLabelText('Access token'), 'bad-token');
    await user.click(screen.getByRole('button', { name: 'Connect Instagram' }));
    expect(service.connectInstagram).toHaveBeenCalledWith('123', 'bad-token', undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent('Token rejected');
    expect(screen.queryByLabelText('Public link to a JPEG photo')).not.toBeInTheDocument();
  });

  it('retains the link and caption when publishing fails', async () => {
    vi.mocked(service.instagramConnection).mockResolvedValue({ id: '123', username: 'example' });
    vi.mocked(service.publishInstagramPhoto).mockRejectedValue(new Error('Publishing failed'));
    const user = userEvent.setup();
    render(<InstagramPublisher />);
    await user.type(await screen.findByLabelText('Public link to a JPEG photo'), 'https://example.com/photo.jpg');
    await user.type(screen.getByLabelText('Caption optional'), 'Hello world');
    await user.click(screen.getByRole('button', { name: 'Publish photo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Publishing failed');
    expect(screen.getByLabelText('Public link to a JPEG photo')).toHaveValue('https://example.com/photo.jpg');
    expect(screen.getByLabelText('Caption optional')).toHaveValue('Hello world');
    expect(screen.getByText(/Check Instagram before retrying/)).toBeInTheDocument();
  });
});
