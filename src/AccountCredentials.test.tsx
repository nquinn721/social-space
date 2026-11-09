import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountCredentials from './AccountCredentials';
import * as profile from './profileService';
import type { Account } from './model';

vi.mock('./profileService', () => ({ hasAccountPassword: vi.fn(), revealAccountPassword: vi.fn(), setAccountPassword: vi.fn() }));
const sample = ['sample', 'value'].join('-');
const account: Account = { id: 'a1', platform: 'x', label: 'Soft Wings', handle: 'softwings', status: 'active', notes: '', signupEmail: 'softwings25@gmail.com' };
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('account credentials', () => {
  it('masks the saved password until revealed', async () => {
    vi.mocked(profile.hasAccountPassword).mockResolvedValue(true);
    vi.mocked(profile.revealAccountPassword).mockResolvedValue(sample);
    const user = userEvent.setup();
    render(<AccountCredentials account={account}/>);
    expect(screen.getByText('softwings25@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('@softwings')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Show password' }));
    expect(await screen.findByText(sample)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(screen.queryByText(sample)).not.toBeInTheDocument();
  });

  it('lets you save a password for an account made elsewhere', async () => {
    vi.mocked(profile.hasAccountPassword).mockResolvedValue(false);
    const user = userEvent.setup();
    render(<AccountCredentials account={account}/>);
    await user.type(await screen.findByLabelText('Save a password'), sample);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(profile.setAccountPassword).toHaveBeenCalledWith('a1', sample);
    expect(await screen.findByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });
  it('changes a saved password', async () => {
    vi.mocked(profile.hasAccountPassword).mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AccountCredentials account={account}/>);
    await user.click(await screen.findByRole('button', { name: 'Change password' }));
    await user.type(screen.getByLabelText('Save a password'), sample);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(profile.setAccountPassword).toHaveBeenCalledWith('a1', sample);
  });
});
