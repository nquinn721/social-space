import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BrandAccounts from './BrandAccounts';
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
vi.mock('./postingService', () => ({ openProfilePage: vi.fn(async () => undefined) }));
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
    expect(openProfilePage).toHaveBeenLastCalledWith({ platform: 'tiktok', brandId: 'b1', accountId: 'tt', handle: 'softwings', email: 'softwings25@gmail.com', inBrowser: false });
    await user.click(within(tiktok).getByRole('button', { name: /Open in browser/ }));
    expect(openProfilePage).toHaveBeenLastCalledWith(expect.objectContaining({ inBrowser: true }));
  });

  it('shows each profile once with its sign-in, its state and one button for what is next', async () => {
    const ig = profile('ig', 'instagram');
    const tt = profile('tt', 'tiktok');
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
    expect(within(tiktok).getByText('Live · not connected')).toBeInTheDocument();
    await user.click(within(tiktok).getByRole('button', { name: 'Connect' }));
    const { connectProfile } = await import('./profileConnections');
    expect(connectProfile).toHaveBeenCalledWith(tt);

    await user.click(screen.getByRole('button', { name: /Add YouTube/ }));
    expect(onAddSocial).toHaveBeenCalledWith('youtube');
    expect(screen.queryByRole('button', { name: /Add Instagram/ })).not.toBeInTheDocument();
  });
});
