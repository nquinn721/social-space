import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner, UpdateSettings } from './AppUpdates';
import * as updates from './updateService';

vi.mock('./updateService', () => ({ checkForUpdate: vi.fn(), installUpdate: vi.fn() }));

const available: updates.UpdateStatus = {
  installedCommit: 'aaaaaaa1111111', latestCommit: 'bbbbbbb2222222', updateAvailable: true,
  newCommits: ['bbbbbbb Add chat assistant', 'ccccccc Fix queue'], blockedReason: null,
};

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('app updates', () => {
  it('stays hidden when the app is up to date', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue({ ...available, latestCommit: available.installedCommit, updateAvailable: false, newCommits: [] });
    const { container } = render(<UpdateBanner/>);
    await vi.waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('offers and starts an update when main has new commits', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
    vi.mocked(updates.installUpdate).mockResolvedValue();
    const user = userEvent.setup();
    render(<UpdateBanner/>);
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(updates.installUpdate).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Update started/)).toBeInTheDocument();
  });

  it('explains why an update is blocked instead of offering it', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue({ ...available, blockedReason: 'The source folder has uncommitted changes (src/App.tsx).' });
    render(<UpdateBanner/>);
    expect(await screen.findByText(/uncommitted changes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });

  it('checks on demand from settings and lists incoming changes', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
    const user = userEvent.setup();
    render(<UpdateSettings/>);
    expect(updates.checkForUpdate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('bbbbbbb Add chat assistant')).toBeInTheDocument();
    expect(screen.getByText('aaaaaaa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
  });

  it('shows the error when the check fails', async () => {
    vi.mocked(updates.checkForUpdate).mockRejectedValue('git fetch origin main failed: offline');
    const user = userEvent.setup();
    render(<UpdateSettings/>);
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  });
});
