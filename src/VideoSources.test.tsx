import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoSources, { checkedLabel } from './VideoSources';
import * as service from './videoSourcesService';
import type { VideoSource } from './videoSourcesService';

vi.mock('./videoSourcesService', () => ({
  listVideoSources: vi.fn(), addVideoSource: vi.fn(), checkVideoSource: vi.fn(),
  renameVideoSource: vi.fn(), removeVideoSource: vi.fn(), openProviderKeys: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

const verified: VideoSource = { id: 'a1', name: 'Kling', provider: 'kling', status: 'verified', checkedAt: Date.now(), creditsRemaining: 120, detail: null };

describe('Video sources', () => {
  it('verifies a new key before adding it and shows the provider branding', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValue([]);
    vi.mocked(service.addVideoSource).mockResolvedValue({ ...verified, name: 'Studio' });
    const user = userEvent.setup();
    render(<VideoSources/>);
    expect(await screen.findByPlaceholderText('Paste your API key')).toBeInTheDocument();
    expect(screen.getByLabelText('Source name')).toHaveAttribute('placeholder', 'Kling');
    await user.type(screen.getByLabelText('Source name'), 'Studio');
    await user.type(screen.getByLabelText('Kling AI API key'), '  sk-test  ');
    await user.click(screen.getByRole('button', { name: /Verify and add/ }));
    expect(service.addVideoSource).toHaveBeenCalledWith('Studio', 'kling', 'sk-test');
    const card = await screen.findByRole('article', { name: 'Studio, Kling AI' });
    expect(card).toHaveClass('provider-kling', 'verified');
    expect(within(card).getByText('Verified')).toBeInTheDocument();
    expect(within(card).getByText('120 units left')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Studio is verified');
  });

  it('keeps the key in the form when the provider rejects it', async () => {
    vi.mocked(service.listVideoSources).mockResolvedValue([]);
    vi.mocked(service.addVideoSource).mockRejectedValue('Kling did not accept this API key.');
    const user = userEvent.setup();
    render(<VideoSources/>);
    await user.type(await screen.findByLabelText('Kling AI API key'), 'wrong');
    await user.click(screen.getByRole('button', { name: /Verify and add/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kling did not accept this API key.');
    expect(screen.getByLabelText('Kling AI API key')).toHaveValue('wrong');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('checks an unchecked source, renames it, and removes it after confirming', async () => {
    const unchecked: VideoSource = { ...verified, status: 'unchecked', checkedAt: null, creditsRemaining: null };
    vi.mocked(service.listVideoSources).mockResolvedValue([unchecked]);
    vi.mocked(service.checkVideoSource).mockResolvedValue(verified);
    vi.mocked(service.renameVideoSource).mockResolvedValue({ ...verified, name: 'Main' });
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
