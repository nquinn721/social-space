import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BrandAccounts, { signInLine } from './BrandAccounts';
import type { Account, Brand } from './model';

const status = vi.hoisted(() => ({
  apps: { meta: 'app-1', tiktok: 'app-2' } as Record<string, string | null>,
  connections: {} as Record<string, { state: 'none' | 'ok' | 'expired' | 'unchecked'; username: string; detail: string }>,
  passwords: {} as Record<string, boolean>,
}));
vi.mock('./setupService', () => ({ useSetupStatus: () => ({ ...status, refresh: vi.fn() }), openSetupPage: vi.fn(async () => undefined), openNeedPage: vi.fn(async () => undefined) }));
import { openNeedPage } from './setupService';
vi.mock('./profileConnections', () => ({
  canConnect: (account: Account) => account.status === 'active',
  connectProfile: vi.fn(async () => 'softwings'),
  disconnectProfile: vi.fn(),
  PROVIDER_OF: { instagram: 'meta', x: 'x', tiktok: 'tiktok', youtube: 'google' },
  useProfileConnections: () => ({ connected: {}, loading: false, refresh: vi.fn(async () => undefined) }),
}));
vi.mock('./profileService', () => ({ onPasswordSaved: () => () => undefined, hasAccountPassword: vi.fn(async () => true), revealAccountPassword: vi.fn(), setAccountPassword: vi.fn() }));
const signIns = vi.hoisted(() => ({ value: {} as Record<string, Record<string, { signedIn: boolean; handle?: string; checkedAt: number }>> }));
vi.mock('./postingService', () => ({ openProfilePage: vi.fn(async () => undefined), openPasswordReset: vi.fn(async () => undefined), saveResetPassword: vi.fn(async () => undefined), postingSignIns: vi.fn(async () => signIns.value), onSignInChange: vi.fn(async () => () => undefined) }));
import { openPasswordReset, openProfilePage, saveResetPassword } from './postingService';
import { connectProfile } from './profileConnections';
afterEach(cleanup);

const brand: Brand = { id: 'b1', name: 'Soft Wings', notes: '' };
const profile = (id: string, platform: Account['platform']): Account => ({ id, platform, label: 'Soft Wings', handle: 'softwings', status: 'active', notes: '', brandId: 'b1', signupEmail: 'softwings25@gmail.com' });

describe('brand accounts', () => {
  it('opens a live profile in Social Space or the browser from its details', async () => {
    status.connections = {};
    render(<BrandAccounts brand={brand} accounts={[profile('tt', 'tiktok')]} loaded busy={false} marks={{}} onEditAccount={vi.fn()}/>);
    const tiktok = screen.getByRole('listitem', { name: 'TikTok profile' });
    // Saved with the main Gmail: one line says so, and the button fixes the login.
    expect(within(tiktok).getByText('Uses your main Gmail')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(tiktok).getByRole('button', { name: 'View TikTok profile' }));
    // The window opens but its sign-in is never filled with the main Gmail.
    expect(openProfilePage).toHaveBeenLastCalledWith({ platform: 'tiktok', brandId: 'b1', accountId: undefined, handle: 'softwings', email: '', inBrowser: false });
    await user.click(within(tiktok).getByRole('button', { name: 'TikTok details' }));
    await user.click(within(tiktok).getByRole('button', { name: /Open in browser/ }));
    expect(openProfilePage).toHaveBeenLastCalledWith(expect.objectContaining({ inBrowser: true }));
  });

  it('shows each profile on one line with its state and one button for what is next', async () => {
    const ig = profile('ig', 'instagram');
    const tt = { ...profile('tt', 'tiktok'), signupEmail: 'softwings25+softwings@gmail.com' };
    status.connections = { ig: { state: 'none', username: '', detail: '' }, tt: { state: 'none', username: '', detail: '' } };
    status.passwords = { ig: true, tt: true };
    const onMark = vi.fn();
    const onAddSocial = vi.fn();
    render(<BrandAccounts brand={brand} accounts={[ig, tt]} loaded busy={false} marks={{}} onMark={onMark} onEditAccount={vi.fn()} onAddSocial={onAddSocial}/>);
    const instagram = screen.getByRole('listitem', { name: 'Instagram profile' });
    // A brand's Instagram is its own standalone account: on the main Gmail it is flagged, and nothing asks for a business Page.
    expect(within(instagram).getByText('Uses your main Gmail')).toBeInTheDocument();
    expect(within(instagram).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(within(instagram).queryByText(/business portfolio|Facebook Page/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(instagram).getByRole('button', { name: 'Instagram details' }));
    expect(within(instagram).getByText('softwings25@gmail.com')).toBeInTheDocument();

    const tiktok = screen.getByRole('listitem', { name: 'TikTok profile' });
    // TikTok posts through its upload page in the brand's window: ready without an API connection.
    expect(within(tiktok).getByText('Not checked')).toBeInTheDocument();
    expect(within(tiktok).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Add YouTube/ }));
    expect(onAddSocial).toHaveBeenCalledWith('youtube');
    expect(screen.queryByRole('button', { name: /Add Instagram/ })).not.toBeInTheDocument();
  });

  it('says when the brand window is not signed in, or signed in as someone else', async () => {
    status.connections = {};
    signIns.value = { b1: { tiktok: { signedIn: false, checkedAt: 0 }, x: { signedIn: true, handle: 'softwings25', checkedAt: 0 } } };
    const own = (id: string, platform: Account['platform']) => ({ ...profile(id, platform), signupEmail: `softwings25+${id}@gmail.com` });
    render(<BrandAccounts brand={brand} accounts={[own('tt', 'tiktok'), own('x', 'x'), profile('yt', 'youtube')]} loaded busy={false} marks={{}} onEditAccount={vi.fn()}/>);
    const tiktok = screen.getByRole('listitem', { name: 'TikTok profile' });
    expect(await within(tiktok).findByText('Not signed in')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(tiktok).getByRole('button', { name: 'Sign in' }));
    expect(openProfilePage).toHaveBeenLastCalledWith(expect.objectContaining({ platform: 'tiktok', accountId: 'tt', inBrowser: false }));
    expect(within(screen.getByRole('listitem', { name: 'X profile' })).getByText('Signed in as @softwings25')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: 'YouTube profile' })).getByText('Not checked')).toBeInTheDocument();
    signIns.value = {};
  });

  it('shows a standalone Facebook account with its own sign-in, posting through the brand window', async () => {
    status.connections = {};
    status.passwords = { fb: true };
    const fb = { ...profile('fb', 'facebook'), handle: 'bunnywhispers', signupEmail: 'softwings25+bunnywhispers@gmail.com' };
    render(<BrandAccounts brand={brand} accounts={[fb]} loaded busy={false} marks={{}} onEditAccount={vi.fn()}/>);
    const facebook = screen.getByRole('listitem', { name: 'Facebook profile' });
    expect(within(facebook).getByText('@bunnywhispers')).toBeInTheDocument();
    expect(within(facebook).getByText('Not checked')).toBeInTheDocument();
    expect(within(facebook).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(facebook).getByRole('button', { name: 'Facebook details' }));
    expect(within(facebook).getByText('softwings25+bunnywhispers@gmail.com')).toBeInTheDocument();
    expect(within(facebook).getByRole('button', { name: /Reset password/ })).toBeInTheDocument();
    expect(within(facebook).queryByText(/business portfolio/)).not.toBeInTheDocument();
    expect(connectProfile).not.toHaveBeenCalled();
    expect(openNeedPage).not.toHaveBeenCalled();
  });

  it('resets a password on the social and saves the new one only once it worked', async () => {
    status.connections = {};
    const tt = { ...profile('tt', 'tiktok'), signupEmail: 'softwings25+softwings@gmail.com' };
    render(<BrandAccounts brand={brand} accounts={[tt]} loaded busy={false} marks={{}} onEditAccount={vi.fn()}/>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'TikTok details' }));
    await user.click(screen.getByRole('button', { name: /Reset password/ }));
    expect(openPasswordReset).toHaveBeenCalledWith({ platform: 'tiktok', brandId: 'b1', accountId: 'tt', handle: 'softwings', email: 'softwings25+softwings@gmail.com' });
    expect(saveResetPassword).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /It worked, save it/ }));
    expect(saveResetPassword).toHaveBeenCalledWith('tt');
  });

  it('words each sign-in state', () => {
    expect(signInLine('TikTok', 'animals', { signedIn: true, handle: 'Animals', checkedAt: 0 }).text).toMatch(/last check saw @Animals/);
    expect(signInLine('YouTube', 'animals', { signedIn: true, checkedAt: 0 }).text).toMatch(/channel was not verified/);
    expect(signInLine('X', '@animals', { signedIn: true, handle: 'other', checkedAt: 0 }).tone).toBe('warning');
    expect(signInLine('X', 'animals', undefined).tone).toBe('unknown');
  });

  it('shows the last observed TikTok account and explains the saved window', async () => {
    status.connections = {};
    signIns.value = { b1: { tiktok: { signedIn: true, handle: 'softwings', checkedAt: 1 } } };
    const tt = { ...profile('tt', 'tiktok'), signupEmail: 'softwings25+softwings@gmail.com' };
    render(<BrandAccounts brand={brand} accounts={[tt]} loaded busy={false} marks={{}} onEditAccount={vi.fn()}/>);
    const row = screen.getByRole('listitem', { name: 'TikTok profile' });
    expect(await within(row).findByText('Signed in')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Check account' })).not.toBeInTheDocument();
    await userEvent.setup().click(within(row).getByRole('button', { name: 'View TikTok profile' }));
    expect(await screen.findByText(/saved browser session/)).toBeInTheDocument();
    signIns.value = {};
  });
});
