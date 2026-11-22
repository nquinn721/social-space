import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrandAccounts from './BrandAccounts';
import type { Account, Brand, Workspace } from './model';
import type { Ayrshare } from './useAyrshare';
import type { BrandSocials } from './ayrshareService';

vi.mock('./profileService', () => ({ onPasswordSaved: () => () => undefined, hasAccountPassword: vi.fn(async () => true), revealAccountPassword: vi.fn(), setAccountPassword: vi.fn() }));
vi.mock('./brandWindowService', async (load) => ({ ...(await load<typeof import('./brandWindowService')>()), openProfilePage: vi.fn(async () => undefined), openPasswordReset: vi.fn(async () => undefined), saveResetPassword: vi.fn(async () => undefined) }));
import { openPasswordReset, openProfilePage, saveResetPassword } from './brandWindowService';
const ayrshare = vi.hoisted(() => ({ value: {} as Partial<Ayrshare> }));
vi.mock('./useAyrshare', () => ({ useAyrshare: () => ayrshare.value }));
afterEach(cleanup);

const brand: Brand = { id: 'b1', name: 'Soft Wings', notes: '' };
const profile = (id: string, platform: Account['platform'], extra: Partial<Account> = {}): Account => ({ id, platform, label: 'Soft Wings', handle: 'softwings', status: 'active', notes: '', brandId: 'b1', signupEmail: 'softwings25+softwings@gmail.com', ...extra });
const workspaceOf = (accounts: Account[]): Workspace => ({ businessName: '', brands: [brand], accounts, channels: [] });

function setAyrshare(connected: boolean, socials?: BrandSocials | null) {
  ayrshare.value = {
    status: connected ? { connected: true, working: true, xKeys: true, account: 'me', detail: null } : { connected: false, working: null, xKeys: false, account: null, detail: null },
    brands: socials === undefined ? {} : { b1: { socials } },
    inputs: () => ({ ayrshare: { connected, xKeys: true }, socials }),
    createProfile: vi.fn(async () => {}), adoptProfile: vi.fn(async () => {}), link: vi.fn(async () => {}), refreshBrand: vi.fn(async () => {}),
  };
}
beforeEach(() => setAyrshare(true, { hasProfile: true, linked: [] }));

function show(accounts: Account[], extra: Partial<Parameters<typeof BrandAccounts>[0]> = {}) {
  return render(<BrandAccounts workspace={workspaceOf(accounts)} brand={brand} accounts={accounts} loaded busy={false} onEditAccount={vi.fn()} {...extra}/>);
}

describe('brand accounts', () => {
  it('sends Connect Ayrshare to Settings when Ayrshare is not connected', async () => {
    setAyrshare(false);
    const navigate = vi.fn();
    show([profile('tt', 'tiktok')], { onNavigate: navigate });
    await userEvent.setup().click(screen.getByRole('button', { name: /Connect Ayrshare/ }));
    expect(navigate).toHaveBeenCalledWith('settings', 'ayrshare');
    // The brand-wide step isn't repeated on every row.
    expect(within(screen.getByRole('listitem', { name: 'TikTok profile' })).queryByRole('button', { name: /Connect Ayrshare/ })).not.toBeInTheDocument();
  });

  it('makes the brand its Ayrshare profile in one click, or takes a pasted profile key', async () => {
    setAyrshare(true, { hasProfile: false, linked: [] });
    show([profile('tt', 'tiktok')]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Set up posting/ }));
    expect(ayrshare.value.createProfile).toHaveBeenCalledWith(brand);
    await user.click(screen.getByRole('button', { name: 'Already have a profile key?' }));
    await user.type(screen.getByLabelText('Ayrshare profile key'), 'KEY-123');
    await user.click(screen.getByRole('button', { name: 'Use it' }));
    expect(ayrshare.value.adoptProfile).toHaveBeenCalledWith(brand, 'KEY-123');
  });

  it('shows what is linked on Ayrshare and links the rest in the brand\'s window', async () => {
    setAyrshare(true, { hasProfile: true, linked: [{ platform: 'instagram', name: 'softwings', refresh: false }] });
    show([profile('ig', 'instagram'), profile('tt', 'tiktok')]);
    expect(within(screen.getByRole('listitem', { name: 'Instagram profile' })).getByText('Ready')).toBeInTheDocument();
    const tiktok = screen.getByRole('listitem', { name: 'TikTok profile' });
    expect(within(tiktok).getByText('Not linked')).toBeInTheDocument();
    expect(screen.getByText(/Link TikTok on Ayrshare/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(tiktok).getByRole('button', { name: 'Link TikTok' }));
    expect(ayrshare.value.link).toHaveBeenCalledWith(brand);
    await user.click(screen.getByRole('button', { name: /Link socials/ }));
    expect(ayrshare.value.link).toHaveBeenCalledTimes(2);
  });

  it('flags a profile saved with the main Gmail and never fills that login', async () => {
    const tt = profile('tt', 'tiktok', { signupEmail: 'softwings25@gmail.com' });
    const edit = vi.fn();
    show([tt], { onEditAccount: edit });
    const row = screen.getByRole('listitem', { name: 'TikTok profile' });
    expect(within(row).getByText('Uses main Gmail')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Give it its own login' }));
    expect(edit).toHaveBeenCalledWith(tt);
    await user.click(within(row).getByRole('button', { name: 'View TikTok profile' }));
    expect(openProfilePage).toHaveBeenLastCalledWith({ platform: 'tiktok', brandId: 'b1', accountId: undefined, handle: 'softwings', email: '', inBrowser: false });
    await user.click(within(row).getByRole('button', { name: 'TikTok details' }));
    expect(within(row).queryByRole('button', { name: /Reset password/ })).not.toBeInTheDocument();
  });

  it('opens profiles, adds socials, and resets a password only saving it once it worked', async () => {
    const onAddSocial = vi.fn();
    show([profile('tt', 'tiktok')], { onAddSocial });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'TikTok details' }));
    expect(screen.getByText('softwings25+softwings@gmail.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Open in browser/ }));
    expect(openProfilePage).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'tt', inBrowser: true }));
    await user.click(screen.getByRole('button', { name: /Reset password/ }));
    expect(openPasswordReset).toHaveBeenCalledWith({ platform: 'tiktok', brandId: 'b1', accountId: 'tt', handle: 'softwings', email: 'softwings25+softwings@gmail.com' });
    expect(saveResetPassword).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /It worked, save it/ }));
    expect(saveResetPassword).toHaveBeenCalledWith('tt');
    await user.click(screen.getByRole('button', { name: /Add YouTube/ }));
    expect(onAddSocial).toHaveBeenCalledWith('youtube');
    expect(screen.queryByRole('button', { name: /Add TikTok/ })).not.toBeInTheDocument();
  });
});
