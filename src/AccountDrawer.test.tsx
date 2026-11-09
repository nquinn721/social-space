import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountDrawer from './AccountDrawer';
import { createAccount } from './model';
import * as profile from './profileService';

vi.mock('./profileService', async (original) => ({ ...(await original<typeof import('./profileService')>()), openPlatformWindow: vi.fn(), fillSiteForm: vi.fn(), chooseImageFile: vi.fn() }));
vi.mock('./AccountCredentials', () => ({ default: () => null }));
vi.mock('./ProfileImageStudio', () => ({ default: () => null }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(profile.openPlatformWindow).mockResolvedValue('site-7'); });
afterEach(cleanup);

const live = { ...createAccount('instagram', 'MassageWithMia', 'massagewithmia', 'active', ''), id: 'acct-1', bio: 'Relax and recover' };
const drawer = (account = live) => render(<AccountDrawer account={account} busy={false} onClose={vi.fn()} onSave={vi.fn()} onRemove={vi.fn()}/>);

describe('Editing a live Instagram profile', () => {
  it('replaces the details already on the profile page', async () => {
    const user = userEvent.setup();
    drawer();
    await user.click(screen.getByRole('button', { name: /Fill profile on Instagram/ }));
    expect(profile.openPlatformWindow).toHaveBeenCalledWith('instagram', 'manage');
    expect(profile.fillSiteForm).toHaveBeenCalledWith('site-7', expect.objectContaining({ bio: 'Relax and recover' }), expect.objectContaining({ replace: true, keepFilling: true }));
  });

  it('fills the new name and username in Accounts Center without saving them', async () => {
    const user = userEvent.setup();
    drawer();
    await user.click(screen.getByRole('button', { name: /Change name & username/ }));
    expect(profile.openPlatformWindow).toHaveBeenCalledWith('instagram', 'identity');
    expect(profile.fillSiteForm).toHaveBeenCalledWith('site-7', { username: 'massagewithmia', fullName: 'MassageWithMia' }, { keepFilling: true, replace: true });
    expect(await screen.findByText(/Accounts Center/)).toBeInTheDocument();
  });

  it('keeps filling only empty fields for accounts not created yet', async () => {
    const user = userEvent.setup();
    drawer({ ...live, status: 'planned' });
    expect(screen.queryByRole('button', { name: /Change name & username/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Fill profile on Instagram/ }));
    expect(profile.fillSiteForm).toHaveBeenCalledWith('site-7', expect.anything(), expect.objectContaining({ replace: false }));
  });
});
