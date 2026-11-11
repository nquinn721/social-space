import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasUpdate, UpdateBanner, updateNavLabel, UpdatesPage, useAppUpdates, type AppUpdates } from './AppUpdates';
import * as updates from './updateService';

vi.mock('./updateService', () => ({ checkForUpdate: vi.fn(), prepareUpdate: vi.fn(), installPreparedUpdate: vi.fn(), restartApp: vi.fn(), updateProgress: vi.fn(), takeUpdateResult: vi.fn(), updateManagement: vi.fn() }));

const MAIN = 'b'.repeat(40);
const available: updates.UpdateStatus = {
  state: 'available', runningVersion: '0.1.0', latestVersion: '0.2.0', sourceDir: 'D:\\Projects\\SocialManager-release', prepared: null,
  installedCommit: 'a'.repeat(40), latestCommit: MAIN, updateAvailable: true,
  newCommits: ['bbbbbbb Add video library', 'ccccccc Fix queue'], blockedReason: null,
};
const ready: updates.UpdateStatus = { ...available, state: 'ready', prepared: { commit: MAIN, installer: 'C:\\setup.exe', sha256: 'f'.repeat(64), builtAt: 1 } };
const upToDate: updates.UpdateStatus = { ...available, state: 'up_to_date', installedCommit: MAIN, updateAvailable: false, newCommits: [] };
const idle: updates.UpdateProgress = { state: 'idle', step: 0, totalSteps: 3, label: '', detail: '', error: null };

function fake(overrides: Partial<AppUpdates> = {}): AppUpdates {
  return { status: available, progress: idle, checking: false, error: '', check: vi.fn().mockResolvedValue(undefined), followProgress: vi.fn().mockResolvedValue(undefined), buildNow: vi.fn().mockResolvedValue(undefined), restartToUpdate: vi.fn().mockResolvedValue(undefined), ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(updates.updateProgress).mockResolvedValue(idle);
  vi.mocked(updates.takeUpdateResult).mockResolvedValue(null);
  vi.mocked(updates.updateManagement).mockResolvedValue({ managedBy: null });
});

/** Lets the management lookup, then the first check, settle. */
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
afterEach(cleanup);

describe('update checks', () => {
  it('checks main at startup and again on the interval', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
      const { result } = renderHook(() => useAppUpdates(1000));
      await settle();
      expect(result.current.status).toEqual(available);
      expect(result.current.managedBy).toBeNull();
      await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
      expect(updates.checkForUpdate).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('never checks, builds or polls while Ava manages updates', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(updates.updateManagement).mockResolvedValue({ managedBy: 'Ava' });
      vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
      const { result } = renderHook(() => useAppUpdates(1000));
      await settle();
      await act(async () => { vi.advanceTimersByTime(5000); await Promise.resolve(); });
      expect(result.current.managedBy).toBe('Ava');
      expect(updates.checkForUpdate).not.toHaveBeenCalled();
      expect(updates.updateProgress).not.toHaveBeenCalled();
      expect(updates.prepareUpdate).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('only offers an update that is not blocked', () => {
    expect(hasUpdate(available)).toBe(true);
    expect(hasUpdate(ready)).toBe(true);
    expect(hasUpdate(upToDate)).toBe(false);
    expect(hasUpdate({ ...available, blockedReason: 'npm is not on PATH.' })).toBe(false);
    expect(hasUpdate(null)).toBe(false);
  });
});

describe('automatic builds', () => {
  it('builds new commits on main on its own, once per commit', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue(available);
    vi.mocked(updates.prepareUpdate).mockResolvedValue();
    const { result } = renderHook(() => useAppUpdates(60_000));
    await vi.waitFor(() => expect(updates.prepareUpdate).toHaveBeenCalledWith(MAIN));
    await act(async () => { await result.current.check(true); });
    expect(updates.prepareUpdate).toHaveBeenCalledOnce();
  });

  it('rebuilds on its own when the built installer is refused at restart', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValueOnce(available).mockResolvedValueOnce(ready).mockResolvedValue(available);
    vi.mocked(updates.prepareUpdate).mockResolvedValue();
    vi.mocked(updates.installPreparedUpdate).mockRejectedValue('The prepared installer was replaced after it was built, so it was not installed. Building the update again now.');
    const { result } = renderHook(() => useAppUpdates(60_000));
    await vi.waitFor(() => expect(updates.prepareUpdate).toHaveBeenCalledOnce());
    await act(async () => { await result.current.check(true); });
    expect(result.current.status?.state).toBe('ready');
    await act(async () => { await result.current.restartToUpdate(); });
    await vi.waitFor(() => expect(updates.prepareUpdate).toHaveBeenCalledTimes(2));
  });

  it('does not build when updating is blocked or already running', async () => {
    vi.mocked(updates.checkForUpdate).mockResolvedValue({ ...available, blockedReason: 'npm is not on PATH.' });
    renderHook(() => useAppUpdates(60_000));
    await vi.waitFor(() => expect(updates.checkForUpdate).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(updates.prepareUpdate).not.toHaveBeenCalled();
  });

  it('names what the update is doing in the sidebar', () => {
    expect(updateNavLabel({ status: upToDate, progress: idle })).toBe('Updates');
    expect(updateNavLabel({ status: available, progress: { ...idle, state: 'running' } })).toBe('Building update…');
    expect(updateNavLabel({ status: ready, progress: { ...idle, state: 'ready' } })).toBe('Update ready');
  });
});

describe('update banner', () => {
  it('stays quiet while main has changes that are still building', () => {
    const { container } = render(<UpdateBanner updates={fake({ progress: { ...idle, state: 'running', step: 2 } })} onOpen={vi.fn()}/>);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers one click to restart into a ready update', async () => {
    const state = fake({ status: ready });
    render(<UpdateBanner updates={state} onOpen={vi.fn()}/>);
    expect(screen.getByText('Update ready: 2 new changes from main. Restart to install it.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(state.restartToUpdate).toHaveBeenCalledOnce();
  });

  it('says why when Restart to update fails, instead of doing nothing', () => {
    render(<UpdateBanner updates={fake({ status: ready, error: 'The prepared installer is gone. Build the update again.' })} onOpen={vi.fn()}/>);
    expect(screen.getByText(/didn't start: The prepared installer is gone/)).toBeInTheDocument();
  });

  it('points to the Updates page when a build failed', async () => {
    const open = vi.fn();
    render(<UpdateBanner updates={fake({ progress: { ...idle, state: 'failed', error: 'npm failed' } })} onOpen={open}/>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'See why' }));
    expect(open).toHaveBeenCalledOnce();
  });

  it('confirms completion after restarting into the new version', async () => {
    vi.mocked(updates.takeUpdateResult).mockResolvedValue({ fromCommit: 'a'.repeat(40), toCommit: MAIN, succeeded: true });
    render(<UpdateBanner updates={fake({ status: upToDate })} onOpen={vi.fn()}/>);
    expect(await screen.findByText('SocialSpace is updated to bbbbbbb.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss update' }));
    expect(screen.queryByText(/is updated/)).not.toBeInTheDocument();
  });

  it('never offers an update while Ava manages updates, but still says one landed', async () => {
    const { container } = render(<UpdateBanner updates={fake({ managedBy: 'Ava', status: ready })} onOpen={vi.fn()}/>);
    await act(async () => { await Promise.resolve(); });
    expect(container).toBeEmptyDOMElement();
    cleanup();
    vi.mocked(updates.takeUpdateResult).mockResolvedValue({ fromCommit: 'a'.repeat(40), toCommit: MAIN, succeeded: false });
    render(<UpdateBanner updates={fake({ managedBy: 'Ava', status: ready })} onOpen={vi.fn()}/>);
    expect(await screen.findByText(/didn't install/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Updates' })).not.toBeInTheDocument();
  });
});

describe('Updates page', () => {
  it('shows the running build, what is new on main and where it builds from', () => {
    render(<UpdatesPage updates={fake()}/>);
    expect(screen.getByText('SocialSpace 0.1.0, build aaaaaaa')).toBeInTheDocument();
    expect(screen.getByText(available.sourceDir)).toBeInTheDocument();
    expect(screen.getByText('0.2.0, build bbbbbbb')).toBeInTheDocument();
    expect(screen.getByText('bbbbbbb Add video library')).toBeInTheDocument();
  });

  it('says so when up to date and offers no update', () => {
    render(<UpdatesPage updates={fake({ status: upToDate })}/>);
    expect(screen.getByText('SocialSpace is up to date with main.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart to update|Build now/ })).not.toBeInTheDocument();
  });

  it('shows the background build as it runs', () => {
    render(<UpdatesPage updates={fake({ progress: { ...idle, state: 'running', step: 3, label: 'Building the new version' } })}/>);
    expect(screen.getByText(/Building 2 new changes from main commit/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '83');
  });

  it('installs a ready update with one click', async () => {
    const state = fake({ status: ready });
    render(<UpdatesPage updates={state}/>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(state.restartToUpdate).toHaveBeenCalledOnce();
  });

  it('explains a failed build and lets you try again', async () => {
    const state = fake({ progress: { ...idle, state: 'failed', error: "'npm run tauri build' failed." } });
    render(<UpdatesPage updates={state}/>);
    expect(screen.getByRole('alert')).toHaveTextContent('npm run tauri build');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try the build again' }));
    expect(state.buildNow).toHaveBeenCalledOnce();
  });

  it('explains why updating is blocked', () => {
    render(<UpdatesPage updates={fake({ status: { ...available, blockedReason: 'npm (npm.cmd) is not on PATH, so the update cannot be built.' } })}/>);
    expect(screen.getByText(/npm .* is not on PATH/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Build now' })).not.toBeInTheDocument();
  });

  it('checks again on demand and restarts without installing', async () => {
    const user = userEvent.setup();
    const state = fake();
    render(<UpdatesPage updates={state}/>);
    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(state.check).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Restart without updating' }));
    expect(updates.restartApp).toHaveBeenCalledOnce();
    expect(updates.installPreparedUpdate).not.toHaveBeenCalled();
  });
});
