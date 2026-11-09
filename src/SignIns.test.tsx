import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignIns from './SignIns';
import { mergeRestored } from './brands';
import * as profile from './profileService';
import type { Account, Workspace } from './model';

vi.mock('./profileService', () => ({ onPasswordSaved: () => () => undefined, hasAccountPassword: vi.fn(), revealAccountPassword: vi.fn(), setAccountPassword: vi.fn(), exportSignIns: vi.fn(), importSignIns: vi.fn() }));
const secret = ['pass', 'word', '42'].join('-');
const account = (id: string, platform: Account['platform'], handle: string): Account => ({ id, platform, label: 'Mia', handle, status: 'active', notes: '', signupEmail: 'softwings25@gmail.com', brandId: 'mia' });
const workspace: Workspace = { businessName: '', channels: [], brands: [{ id: 'mia', name: 'Massage With Mia', notes: '' }], accounts: [account('ig', 'instagram', 'softwings'), account('tt', 'tiktok', 'massagewithmia')] };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(profile.hasAccountPassword).mockImplementation(async (id) => id === 'ig'); });
afterEach(cleanup);

describe('sign-ins', () => {
  it('lists every account with username, email and password, and saves a missing password', async () => {
    vi.mocked(profile.revealAccountPassword).mockResolvedValue(secret);
    const user = userEvent.setup();
    render(<SignIns workspace={workspace} busy={false} onEdit={vi.fn()} onRestore={vi.fn()}/>);
    const table = screen.getByRole('table', { name: 'All sign-ins' });
    expect(within(table).getByText('softwings')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Show password for Instagram @softwings' }));
    expect(await screen.findByText(secret)).toBeInTheDocument();
    await user.type(await screen.findByLabelText('New password for TikTok @massagewithmia'), secret);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(profile.setAccountPassword).toHaveBeenCalledWith('tt', secret);
  });

  it('backs up with a passphrase and restores missing accounts', async () => {
    vi.mocked(profile.exportSignIns).mockResolvedValue('backup.ssbackup');
    const backup: Workspace = { ...workspace, accounts: [...workspace.accounts, account('x1', 'x', 'mia_x')] };
    vi.mocked(profile.importSignIns).mockResolvedValue({ workspace: backup, passwordsRestored: 3, createdAt: 1 });
    const onRestore = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<SignIns workspace={workspace} busy={false} onEdit={vi.fn()} onRestore={onRestore}/>);
    await user.click(screen.getByRole('button', { name: 'Back up sign-ins' }));
    await user.type(screen.getByLabelText(/Choose a passphrase/), 'long passphrase');
    await user.click(screen.getByRole('button', { name: 'Save backup file' }));
    expect(profile.exportSignIns).toHaveBeenCalledWith('long passphrase');
    expect(await screen.findByText(/Saved backup.ssbackup/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.type(screen.getByLabelText(/Passphrase of the backup/), 'long passphrase');
    await user.click(screen.getByRole('button', { name: 'Choose file and restore' }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ accounts: expect.arrayContaining([expect.objectContaining({ id: 'x1' })]) }), 'Restored 3 passwords and 1 missing accounts from the backup.'));
  });

  it('never overwrites what is already here when restoring', () => {
    const changed = { ...workspace, accounts: [{ ...workspace.accounts[0], handle: 'old' }] };
    const { workspace: merged, added } = mergeRestored(workspace, changed);
    expect(added).toBe(0);
    expect(merged.accounts[0].handle).toBe('softwings');
  });
});
