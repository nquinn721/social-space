import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner, UpdateSettings } from './AppUpdates';
import * as updates from './updateService';

vi.mock('./updateService', () => ({ checkForUpdate: vi.fn(), installUpdate: vi.fn(), updateProgress: vi.fn(), takeUpdateResult: vi.fn() }));

const available: updates.UpdateStatus = {
  installedCommit: 'aaaaaaa1111111', latestCommit: 'bbbbbbb2222222', updateAvailable: true,
  newCommits: ['bbbbbbb Add chat assistant', 'ccccccc Fix queue'], blockedReason: null,
};

const idle: updates.UpdateProgress = { state: 'idle', step: 0, totalSteps: 4, label: '', detail: '', error: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(updates.updateProgress).mockResolvedValue(idle);
  vi.mocked(updates.takeUpdateResult).mockResolvedValue(null);
});
afterEach(cleanup);

describe('app updates', () => {
  it('stays hidden when the app is up to date', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue({ ...available, latestCommit: available.installedCommit, updateAvailable: false, newCommits: [] });
    const { container } = render(<UpdateBanner/>);
    await vi.waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('runs the update in the background and shows its progress in the app', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
    vi.mocked(updates.installUpdate).mockResolvedValue();
    const user = userEvent.setup();
    render(<UpdateBanner/>);
    const button = await screen.findByRole('button', { name: 'Update now' });
    vi.mocked(updates.updateProgress).mockResolvedValue({ state: 'running', step: 3, totalSteps: 4, label: 'Building the new version', detail: 'Compiling tauri v2.8.0', error: null });
    await user.click(button);
    expect(updates.installUpdate).toHaveBeenCalledOnce();
    expect(await screen.findByText('Updating SocialSpace · Step 3 of 4: Building the new version…')).toBeInTheDocument();
    expect(screen.getByText('Compiling tauri v2.8.0')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63');
  });

  it('shows a failed update with a retry', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
    vi.mocked(updates.updateProgress).mockResolvedValue({ ...idle, state: 'failed', error: "'npm run tauri build' failed." });
    render(<UpdateBanner/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Update failed');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('confirms completion after restarting into the new version', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue({ ...available, installedCommit: 'bbbbbbb2222222', updateAvailable: false, newCommits: [] });
    vi.mocked(updates.takeUpdateResult).mockResolvedValue({ fromCommit: 'aaaaaaa1111111', toCommit: 'bbbbbbb2222222', succeeded: true });
    const user = userEvent.setup();
    render(<UpdateBanner/>);
    expect(await screen.findByText('SocialSpace is updated to bbbbbbb.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss update' }));
    expect(screen.queryByText(/is updated/)).not.toBeInTheDocument();
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
