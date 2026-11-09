import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasUpdate, UpdateBanner, UpdatesPage, useAppUpdates, type AppUpdates } from './AppUpdates';
import * as updates from './updateService';

vi.mock('./updateService', () => ({ checkForUpdate: vi.fn(), prepareUpdate: vi.fn(), installPreparedUpdate: vi.fn(), restartApp: vi.fn(), updateProgress: vi.fn(), takeUpdateResult: vi.fn() }));

const MAIN = 'b'.repeat(40);
const available: updates.UpdateStatus = {
  state: 'available', runningVersion: '0.1.0', sourceDir: 'D:\\Projects\\SocialManager-release', prepared: null,
  installedCommit: 'a'.repeat(40), latestCommit: MAIN, updateAvailable: true,
  newCommits: ['bbbbbbb Add video library', 'ccccccc Fix queue'], blockedReason: null,
};
const ready: updates.UpdateStatus = { ...available, state: 'ready', prepared: { commit: MAIN, installer: 'C:\\setup.exe', sha256: 'f'.repeat(64), builtAt: 1 } };
const upToDate: updates.UpdateStatus = { ...available, state: 'up_to_date', installedCommit: MAIN, updateAvailable: false, newCommits: [] };
const idle: updates.UpdateProgress = { state: 'idle', step: 0, totalSteps: 3, label: '', detail: '', error: null };

function fake(overrides: Partial<AppUpdates> = {}): AppUpdates {
  return { status: available, progress: idle, checking: false, error: '', check: vi.fn().mockResolvedValue(undefined), followProgress: vi.fn().mockResolvedValue(undefined), ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(updates.updateProgress).mockResolvedValue(idle);
  vi.mocked(updates.takeUpdateResult).mockResolvedValue(null);
});
afterEach(cleanup);

describe('update checks', () => {
  it('checks main at startup and again on the interval', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
      const { result } = renderHook(() => useAppUpdates(1000));
      await act(async () => { await Promise.resolve(); });
      expect(result.current.status).toEqual(available);
      await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
      expect(updates.checkForUpdate).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('only offers an update that is not blocked', () => {
    expect(hasUpdate(available)).toBe(true);
    expect(hasUpdate(ready)).toBe(true);
    expect(hasUpdate(upToDate)).toBe(false);
    expect(hasUpdate({ ...available, blockedReason: 'Uncommitted changes.' })).toBe(false);
    expect(hasUpdate(null)).toBe(false);
  });
});

describe('update banner', () => {
  it('stays hidden when the app is up to date', () => {
    const { container } = render(<UpdateBanner updates={fake({ status: upToDate })} onOpen={vi.fn()}/>);
    expect(container).toBeEmptyDOMElement();
  });

  it('points to the Updates page when main has changes', async () => {
    const open = vi.fn();
    render(<UpdateBanner updates={fake()} onOpen={open}/>);
    expect(screen.getByText('2 new changes on main for SocialSpace.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'View update' }));
    expect(open).toHaveBeenCalledOnce();
  });

  it('follows a running build', () => {
    render(<UpdateBanner updates={fake({ progress: { state: 'running', step: 3, totalSteps: 3, label: 'Building the new version', detail: 'Compiling tauri v2.8.0', error: null } })} onOpen={vi.fn()}/>);
    expect(screen.getByText('Building the update · Step 3 of 3: Building the new version…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '83');
  });

  it('confirms completion after restarting into the new version', async () => {
    vi.mocked(updates.takeUpdateResult).mockResolvedValue({ fromCommit: 'a'.repeat(40), toCommit: MAIN, succeeded: true });
    render(<UpdateBanner updates={fake({ status: upToDate })} onOpen={vi.fn()}/>);
    expect(await screen.findByText('SocialSpace is updated to bbbbbbb.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss update' }));
    expect(screen.queryByText(/is updated/)).not.toBeInTheDocument();
  });
});

describe('Updates page', () => {
  it('shows the running build, what is new on main and where it builds from', () => {
    render(<UpdatesPage updates={fake()}/>);
    expect(screen.getByText('SocialSpace 0.1.0, build aaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('D:\\Projects\\SocialManager-release')).toBeInTheDocument();
    expect(screen.getByText('bbbbbbb Add video library')).toBeInTheDocument();
  });

  it('says so when up to date and offers no update', () => {
    render(<UpdatesPage updates={fake({ status: upToDate })}/>);
    expect(screen.getByText('SocialSpace is up to date with main.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update SocialSpace' })).toBeDisabled();
  });

  it('builds only the main commit that was reviewed', async () => {
    vi.mocked(updates.prepareUpdate).mockResolvedValue();
    const user = userEvent.setup();
    const state = fake();
    render(<UpdatesPage updates={state}/>);
    await user.click(screen.getByRole('button', { name: 'Update SocialSpace' }));
    expect(screen.getByText('Build the available update?')).toBeInTheDocument();
    expect(updates.prepareUpdate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Build update' }));
    expect(updates.prepareUpdate).toHaveBeenCalledWith(MAIN);
    expect(state.followProgress).toHaveBeenCalled();
  });

  it('asks before installing a built update and restarting', async () => {
    vi.mocked(updates.installPreparedUpdate).mockResolvedValue();
    const user = userEvent.setup();
    render(<UpdatesPage updates={fake({ status: ready })}/>);
    expect(screen.getByText(/ready to install/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Install update' }));
    expect(updates.installPreparedUpdate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(updates.installPreparedUpdate).toHaveBeenCalledOnce();
  });

  it('opens the install step when a build finishes on the page', () => {
    const running = fake({ progress: { ...idle, state: 'running', step: 3, label: 'Building the new version' } });
    const { rerender } = render(<UpdatesPage updates={running}/>);
    rerender(<UpdatesPage updates={fake({ status: ready, progress: { ...idle, state: 'ready' } })}/>);
    expect(screen.getByText('Install this update?')).toBeInTheDocument();
  });

  it('explains why an update is blocked or failed', () => {
    render(<UpdatesPage updates={fake({ status: { ...available, blockedReason: 'The source folder has uncommitted changes (src/App.tsx).' }, progress: { ...idle, state: 'failed', error: "'npm run tauri build' failed." } })}/>);
    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('npm run tauri build');
    expect(screen.getByRole('button', { name: 'Update SocialSpace' })).toBeDisabled();
  });

  it('checks again on demand and restarts without installing', async () => {
    const user = userEvent.setup();
    const state = fake();
    render(<UpdatesPage updates={state}/>);
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(state.check).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Restart SocialSpace' }));
    expect(updates.restartApp).toHaveBeenCalledOnce();
    expect(updates.installPreparedUpdate).not.toHaveBeenCalled();
  });
});
