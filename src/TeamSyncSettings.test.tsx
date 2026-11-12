import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeamSyncSettings from './TeamSyncSettings';
import { PartnerReviewProvider, type PartnerReview } from './usePartnerReview';
import type { TeamSync } from './useTeamSync';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));

const review = { connection: { clientEmail: 'sa@x', projectId: 'socialspace-review', site: '' }, posts: {}, error: '', refresh: vi.fn(), setConnection: vi.fn(), send: vi.fn() } as PartnerReview;
const sync = (over: Partial<TeamSync> = {}): TeamSync => ({ status: { reviewConnected: true, enabled: false, lastSyncedAt: 0 }, syncing: false, error: '', syncNow: vi.fn(), enable: vi.fn().mockResolvedValue(true), disable: vi.fn(), saved: vi.fn(), ...over });
const show = (value: TeamSync, connected = true) => render(<PartnerReviewProvider value={connected ? review : { ...review, connection: null }}><TeamSyncSettings sync={value}/></PartnerReviewProvider>);

describe('TeamSyncSettings', () => {
  it('asks for Partner review first', () => {
    show(sync(), false);
    expect(screen.getByText(/Connect Partner review above first/)).toBeTruthy();
  });

  it('turns sharing on only when both passphrases match', async () => {
    const value = sync();
    show(value);
    fireEvent.change(screen.getByLabelText('Team passphrase'), { target: { value: 'long enough pass' } });
    fireEvent.change(screen.getByLabelText('Type it again'), { target: { value: 'different pass!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on sharing' }));
    expect(screen.getByRole('alert').textContent).toMatch(/different/);
    expect(value.enable).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Type it again'), { target: { value: 'long enough pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on sharing' }));
    await waitFor(() => expect(value.enable).toHaveBeenCalledWith('long enough pass'));
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('shows the last sync and syncs on demand once on', () => {
    const value = sync({ status: { reviewConnected: true, enabled: true, lastSyncedAt: Date.now() } });
    show(value);
    expect(screen.getByText(/Last synced just now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sync now/ }));
    expect(value.syncNow).toHaveBeenCalled();
  });
});
