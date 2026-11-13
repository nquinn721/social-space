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
vi.mock('./setupService', () => ({ useSetupStatus: () => ({ ...status, refresh: vi.fn() }), openSetupPage: vi.fn(async () => undefined) }));
vi.mock('./profileConnections', () => ({
  canConnect: (account: Account) => account.status === 'active',
  connectProfile: vi.fn(async () => 'softwings'),
  disconnectProfile: vi.fn(),
  PROVIDER_OF: { instagram: 'meta', x: 'x', tiktok: 'tiktok', youtube: 'google' },
  useProfileConnections: () => ({ connected: {}, loading: false, refresh: vi.fn(async () => undefined) }),
}));
vi.mock('./profileService', () => ({ onPasswordSaved: () => () => undefined, hasAccountPassword: vi.fn(async () => true), revealAccountPassword: vi.fn(), setAccountPassword: vi.fn() }));
const signIns = vi.hoisted(() => ({ value: {} as Record<string, Record<string, { signedIn: boolean; handle?: string; checkedAt: number }>> }));
vi.mock('./postingService', () => ({ openProfilePage: vi.fn(async () => undefined), postingSignIns: vi.fn(async () => signIns.value), onSignInChange: vi.fn(async () => () => undefined) }));
import { openProfilePage } from './postingService';
afterEach(cleanup);

const brand: Brand = { id: 'b1', name: 'Soft Wings', notes: '' };
const profile = (id: string, platform: Account['platform']): Account => ({ id, platform, label: 'Soft Wings', handle: 'softwings', status: 'active', notes: '', brandId: 'b1', signupEmail: 'softwings25@gmail.com' });

describe('brand accounts', () => {
  it('opens a live profile in Social Space or the browser to see its videos', async () => {
    status.connections = {};
    render(<BrandAccounts brand={brand} accounts={[profile('tt', 'tiktok')]} loaded busy={false} marks={{}} onEditAccount={vi.fn()}/>);
    const tiktok = screen.getByRole('article', { name: 'TikTok profile' });
    const user = userEvent.setup();
    await user.click(within(tiktok).getByRole('button', { name: /Open in Social Space/ }));
    // Saved with the main Gmail: the window opens but its sign-in is never filled with it.
    expect(openProfilePage).toHaveBeenLastCalledWith({ platform: 'tiktok', brandId: 'b1', accountId: undefined, handle: 'softwings', email: '', inBrowser: false });
    expect(within(tiktok).getByText(/Saved with your main Gmail/)).toBeInTheDocument();
    await user.click(within(tiktok).getByRole('button', { name: /Open in browser/ }));
    expect(openProfilePage).toHaveBeenLastCalledWith(expect.objectContaining({ inBrowser: true }));
  });

  it('shows each profile once with its sign-in, its state and one button for what is next', async () => {
    const ig = profile('ig', 'instagram');
    const tt = { ...profile('tt', 'tiktok'), signupEmail: 'softwings25+softwings@gmail.com' };
    status.connections = { ig: { state: 'ok', username: 'softwings', detail: '' }, tt: { state: 'none', username: '', detail: '' } };
    status.passwords = { ig: true, tt: true };
    const onMark = vi.fn();
    const onAddSocial = vi.fn();
    render(<BrandAccounts brand={brand} accounts={[ig, tt]} loaded busy={false} marks={{}} onMark={onMark} onEditAccount={vi.fn()} onAddSocial={onAddSocial}/>);
    const instagram = screen.getByRole('article', { name: 'Instagram profile' });
    expect(within(instagram).getByText('Connected · 2 steps left')).toBeInTheDocument();
    expect(within(instagram).getByText('softwings25@gmail.com')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(within(instagram).getByRole('list', { name: 'Instagram steps left' })).getAllByRole('button', { name: 'Done' })[0]);
    expect(onMark).toHaveBeenCalledWith('ig:professional', true);

    const tiktok = screen.getByRole('article', { name: 'TikTok profile' });
    // TikTok posts through its upload page in the brand's window: ready without an API connection.
    expect(within(tiktok).getByText('Ready to post')).toBeInTheDocument();
    expect(within(tiktok).queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Add YouTube/ }));
    expect(onAddSocial).toHaveBeenCalledWith('youtube');
    expect(screen.queryByRole('button', { name: /Add Instagram/ })).not.toBeInTheDocument();
  });

  it('says whether the brand window is signed in, and as whom', async () => {
    status.connections = {};
    signIns.value = { b1: { tiktok: { signedIn: false, checkedAt: 0 }, x: { signedIn: true, handle: 'softwings25', checkedAt: 0 } } };
    render(<BrandAccounts brand={brand} accounts={[profile('tt', 'tiktok'), profile('x', 'x'), profile('yt', 'youtube')]} loaded busy={false} marks={{}} onEditAccount={vi.fn()}/>);
    expect(await screen.findByLabelText('TikTok window sign-in')).toHaveTextContent(/Not signed in to TikTok/);
    expect(screen.getByLabelText('X window sign-in')).toHaveTextContent(/Signed in as @softwings25, not @softwings/);
    expect(screen.getByLabelText('YouTube window sign-in')).toHaveTextContent(/not checked yet/);
    signIns.value = {};
  });

  it('words each sign-in state', () => {
    expect(signInLine('TikTok', 'animals', { signedIn: true, handle: 'Animals', checkedAt: 0 }).tone).toBe('ok');
    expect(signInLine('YouTube', 'animals', { signedIn: true, checkedAt: 0 }).text).toMatch(/^Signed in to YouTube/);
    expect(signInLine('X', '@animals', { signedIn: true, handle: 'other', checkedAt: 0 }).tone).toBe('warning');
    expect(signInLine('X', 'animals', undefined).tone).toBe('unknown');
  });
});
