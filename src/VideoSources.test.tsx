import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import VideoSources, { checkedLabel } from './VideoSources';
import * as service from './videoSourcesService';
import type { VideoSource } from './videoSourcesService';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('./videoSourcesService', async (original) => ({
  DESKTOP_ONLY: (await original<typeof import('./videoSourcesService')>()).DESKTOP_ONLY,
  listVideoSources: vi.fn(), addVideoSource: vi.fn(), checkVideoSource: vi.fn(), setActiveVideoSource: vi.fn(),
  renameVideoSource: vi.fn(), removeVideoSource: vi.fn(), openProviderKeys: vi.fn(),
}));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });
afterEach(cleanup);

const kling: VideoSource = { id: 'a1', name: 'Kling', provider: 'kling', status: 'verified', checkedAt: Date.now(), creditsRemaining: 120, detail: null };
const grok: VideoSource = { id: 'g1', name: 'Grok', provider: 'grok', status: 'verified', checkedAt: Date.now(), creditsRemaining: null, detail: null };

describe('Video sources', () => {
  it('verifies a new Grok key before adding it and shows the provider branding', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValueOnce({ active: null, sources: [] }).mockResolvedValueOnce({ active: 'g1', sources: [{ ...grok, name: 'Studio' }] });
    vi.mocked(service.addVideoSource).mockResolvedValue({ ...grok, name: 'Studio' });
    const user = userEvent.setup();
    render(<VideoSources/>);
    await user.click(await screen.findByRole('radio', { name: /Grok Imagine/ }));
    expect(screen.getByLabelText('Source name')).toHaveAttribute('placeholder', 'Grok');
    await user.type(screen.getByLabelText('Source name'), 'Studio');
    await user.type(screen.getByLabelText('Grok Imagine API key'), '  xai-test  ');
    await user.click(screen.getByRole('button', { name: /Verify and add/ }));
    expect(service.addVideoSource).toHaveBeenCalledWith('Studio', 'grok', 'xai-test');
    const card = await screen.findByRole('article', { name: 'Studio, Grok Imagine' });
    expect(card).toHaveClass('provider-grok', 'verified', 'active');
    expect(within(card).getByText('Verified')).toBeInTheDocument();
    expect(within(card).getByText('Used for all videos')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Studio is verified');
  });

  it('switches which source all video generation uses', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValue({ active: 'a1', sources: [kling, grok] });
    vi.mocked(service.setActiveVideoSource).mockResolvedValue({ active: 'g1', sources: [kling, grok] });
    const user = userEvent.setup();
    render(<VideoSources/>);
    expect(await screen.findByText(/All video generation uses/)).toHaveTextContent('Kling');
    await user.selectOptions(screen.getByLabelText('Active video source'), 'g1');
    expect(service.setActiveVideoSource).toHaveBeenCalledWith('g1');
    expect(await screen.findByRole('status')).toHaveTextContent('Video generation now uses this source.');
    expect(screen.getByText(/All video generation uses/)).toHaveTextContent('Grok');
  });

  it('keeps the key in the form when the provider rejects it', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValue({ active: null, sources: [] });
    vi.mocked(service.addVideoSource).mockRejectedValue('Kling did not accept this API key.');
    const user = userEvent.setup();
    render(<VideoSources/>);
    await user.type(await screen.findByLabelText('Kling AI API key'), 'wrong');
    await user.click(screen.getByRole('button', { name: /Verify and add/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kling did not accept this API key.');
    expect(screen.getByLabelText('Kling AI API key')).toHaveValue('wrong');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('shows the real error in the desktop app instead of asking to open it', async () => {
    vi.mocked(service.listVideoSources).mockRejectedValue('Command list_video_sources not allowed');
    render(<VideoSources/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Command list_video_sources not allowed');
    expect(screen.queryByText(/Open the desktop app/)).not.toBeInTheDocument();
  });

  it('asks to open the desktop app only in a browser', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(service.listVideoSources).mockRejectedValue(new Error('anything'));
    render(<VideoSources/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Open the desktop app to manage video sources.');
  });

  it('checks an unchecked source, renames it, and removes it after confirming', async () => {
    const unchecked: VideoSource = { ...kling, status: 'unchecked', checkedAt: null, creditsRemaining: null };
    vi.mocked(service.listVideoSources)
      .mockResolvedValueOnce({ active: 'a1', sources: [unchecked] })
      .mockResolvedValueOnce({ active: 'a1', sources: [kling] })
      .mockResolvedValueOnce({ active: 'a1', sources: [{ ...kling, name: 'Main' }] })
      .mockResolvedValueOnce({ active: null, sources: [] });
    vi.mocked(service.checkVideoSource).mockResolvedValue(kling);
    vi.mocked(service.renameVideoSource).mockResolvedValue({ ...kling, name: 'Main' });
    vi.mocked(service.removeVideoSource).mockResolvedValue();
    const user = userEvent.setup();
    render(<VideoSources/>);
    const card = await screen.findByRole('article', { name: 'Kling, Kling AI' });
    expect(card).not.toHaveClass('verified');
    await user.click(within(card).getByRole('button', { name: 'Check key' }));
    expect(service.checkVideoSource).toHaveBeenCalledWith('a1');
    expect(await within(card).findByText('Verified')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Rename' }));
    const input = within(card).getByLabelText('Source name');
    await user.clear(input);
    await user.type(input, 'Main{Enter}');
    expect(service.renameVideoSource).toHaveBeenCalledWith('a1', 'Main');
    const renamed = await screen.findByRole('article', { name: 'Main, Kling AI' });

    await user.click(within(renamed).getByRole('button', { name: 'Remove' }));
    expect(service.removeVideoSource).not.toHaveBeenCalled();
    await user.click(within(renamed).getByRole('button', { name: 'Remove' }));
    expect(service.removeVideoSource).toHaveBeenCalledWith('a1');
    expect(await screen.findByText('Removed Main.')).toBeInTheDocument();
  });

  it('describes when a key was last checked', () => {
    const now = 1_000_000_000;
    expect(checkedLabel(null, now)).toBe('Not checked yet');
    expect(checkedLabel(now - 5_000, now)).toBe('Checked just now');
    expect(checkedLabel(now - 5 * 60_000, now)).toBe('Checked 5 min ago');
    expect(checkedLabel(now - 3 * 3_600_000, now)).toBe('Checked 3 h ago');
  });
});
