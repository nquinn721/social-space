import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Connections from './Connections';
import type { Account } from './model';
import * as instagram from './instagramService';
import * as x from './xService';
import * as apps from './devAppsService';
import * as social from './socialConnectService';

vi.mock('./emailService', () => ({ emailConnection: vi.fn(async () => ({ host: 'gmail', username: 'softwings25@gmail.com', kind: 'gmail' })), connectGmailSession: vi.fn(), openGmailSignIn: vi.fn() }));
vi.mock('./instagramService', () => ({ INSTAGRAM_REDIRECT_URI: 'https://nquinn721.github.io/socialspace/instagram', claimInstagramConnection: vi.fn(), connectInstagramApp: vi.fn(), disconnectInstagram: vi.fn(), saveInstagramApp: vi.fn(), finishInstagramConnection: vi.fn(), INSTAGRAM_ID_NEEDED: 'INSTAGRAM_ID_NEEDED' }));
vi.mock('./xService', () => ({ claimXConnection: vi.fn(), connectX: vi.fn(), disconnectX: vi.fn() }));
vi.mock('./videoSourcesService', () => ({ listVideoSources: vi.fn(async () => ({ active: null, sources: [] })) }));
vi.mock('./socialConnectService', () => ({ YOUTUBE_REDIRECT_URI: 'http://127.0.0.1:49174/socialspace/youtube', TIKTOK_REDIRECT_URI: 'https://localhost/socialspace/tiktok', youtubeConnection: vi.fn(async () => null), tiktokConnection: vi.fn(async () => null), connectYoutube: vi.fn(), connectTiktok: vi.fn(), disconnectYoutube: vi.fn(), disconnectTiktok: vi.fn() }));
vi.mock('./devAppsService', () => ({ listDeveloperApps: vi.fn(), saveDeveloperApp: vi.fn() }));
vi.mock('./service', () => ({ openPlatformAction: vi.fn() }));

const profile = (id: string, platform: Account['platform'], handle: string, brandId: string, status: Account['status'] = 'active'): Account => ({ id, platform, label: brandId, handle, status, notes: '', brandId });
const brands = [{ id: 'mia', name: 'Massage With Mia', notes: '' }, { id: 'lisa', name: 'MassageMentor', notes: '' }];
const accounts = [profile('ig-mia', 'instagram', 'massagewithmia', 'mia'), profile('ig-lisa', 'instagram', 'massagelisa', 'lisa'), profile('x-mia', 'x', 'mia_x', 'mia'), profile('tt-mia', 'tiktok', 'mia', 'mia'), profile('yt-lisa', 'youtube', 'lisa', 'lisa', 'planned')];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apps.listDeveloperApps).mockResolvedValue([{ provider: 'meta', id: '123' }, { provider: 'x', id: null }, { provider: 'tiktok', id: null }, { provider: 'google', id: null }]);
  vi.mocked(instagram.claimInstagramConnection).mockImplementation(async (id) => id === 'ig-mia' ? { id: '1', username: 'massagewithmia' } : null);
  vi.mocked(x.claimXConnection).mockResolvedValue(null);
});
afterEach(cleanup);
const row = (name: string) => screen.getByRole('generic', { name });

describe('connections', () => {
  it('shows each live profile with its own connection', async () => {
    render(<Connections onNavigate={vi.fn()} accounts={accounts} brands={brands}/>);
    expect(await within(row('Instagram @massagewithmia')).findByText('Connected')).toBeInTheDocument();
    expect(within(row('Instagram @massagelisa')).getByText('Not connected')).toBeInTheDocument();
    expect(within(row('TikTok @mia')).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('generic', { name: 'YouTube @lisa' })).not.toBeInTheDocument();
    expect(instagram.claimInstagramConnection).toHaveBeenCalledWith('ig-lisa', 'massagelisa');
    expect(within(screen.getByRole('generic', { name: 'Developer apps' })).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('connects one profile with one click through its own approval window', async () => {
    vi.mocked(instagram.connectInstagramApp).mockResolvedValue({ id: '2', username: 'massagelisa' });
    const user = userEvent.setup();
    render(<Connections onNavigate={vi.fn()} accounts={accounts} brands={brands}/>);
    await within(row('Instagram @massagewithmia')).findByText('Connected');
    await user.click(within(row('Instagram @massagelisa')).getByRole('button', { name: 'Connect' }));
    expect(instagram.connectInstagramApp).toHaveBeenCalledWith('ig-lisa', 'massagelisa', undefined);
    expect(await screen.findByText('Instagram connected as @massagelisa for MassageMentor.')).toBeInTheDocument();
  });

  it('passes a known Instagram account ID so Connect can finish without asking', async () => {
    vi.mocked(instagram.connectInstagramApp).mockResolvedValue({ id: '17841466785898395', username: 'massagelisa' });
    const withId = accounts.map((account) => account.id === 'ig-lisa' ? { ...account, platformId: '17841466785898395' } : account);
    const user = userEvent.setup();
    render(<Connections onNavigate={vi.fn()} accounts={withId} brands={brands}/>);
    await within(row('Instagram @massagewithmia')).findByText('Connected');
    await user.click(within(row('Instagram @massagelisa')).getByRole('button', { name: 'Connect' }));
    expect(instagram.connectInstagramApp).toHaveBeenCalledWith('ig-lisa', 'massagelisa', '17841466785898395');
    expect(await screen.findByText('Instagram connected as @massagelisa for MassageMentor.')).toBeInTheDocument();
  });

  it('finishes with the Instagram account ID when Meta does not name the account', async () => {
    vi.mocked(instagram.connectInstagramApp).mockRejectedValue('INSTAGRAM_ID_NEEDED: Meta did not share an Instagram account.');
    vi.mocked(instagram.finishInstagramConnection).mockResolvedValue({ id: '17841466785898395', username: 'massagelisa' });
    const user = userEvent.setup();
    render(<Connections onNavigate={vi.fn()} accounts={accounts} brands={brands}/>);
    await within(row('Instagram @massagewithmia')).findByText('Connected');
    await user.click(within(row('Instagram @massagelisa')).getByRole('button', { name: 'Connect' }));
    const form = await screen.findByRole('form', { name: 'Finish connecting Instagram' });
    await user.type(within(form).getByLabelText('Instagram account ID'), ' 17841466785898395 ');
    await user.click(within(form).getByRole('button', { name: 'Finish connecting' }));
    expect(instagram.finishInstagramConnection).toHaveBeenCalledWith('ig-lisa', '17841466785898395');
    expect(await screen.findByText('Instagram connected as @massagelisa for MassageMentor.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Finish connecting Instagram' })).not.toBeInTheDocument();
  });

  it('asks for the Meta app with its Unified login configuration once, then connects', async () => {
    vi.mocked(instagram.connectInstagramApp).mockRejectedValueOnce('SETUP_NEEDED').mockResolvedValueOnce({ id: '2', username: 'massagelisa' });
    const user = userEvent.setup();
    render(<Connections onNavigate={vi.fn()} accounts={accounts} brands={brands}/>);
    await within(row('Instagram @massagewithmia')).findByText('Connected');
    await user.click(within(row('Instagram @massagelisa')).getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: /Copy the App ID and secret/ }));
    const form = await screen.findByRole('form', { name: 'Instagram keys' });
    await user.type(within(form).getByLabelText('App ID'), '1234567890');
    await user.type(within(form).getByLabelText('App secret'), 'abcdef0123456789abcdef0123456789');
    await user.type(within(form).getByLabelText('Configuration ID'), '555666777');
    await user.click(within(form).getByRole('button', { name: 'Save and connect' }));
    expect(instagram.saveInstagramApp).toHaveBeenCalledWith('1234567890', 'abcdef0123456789abcdef0123456789', '555666777');
    expect(apps.saveDeveloperApp).not.toHaveBeenCalledWith('meta', expect.anything(), expect.anything());
    expect(await screen.findByText('Instagram connected as @massagelisa for MassageMentor.')).toBeInTheDocument();
  });

  it('asks for the X app once, then connects that X profile', async () => {
    vi.mocked(x.connectX).mockRejectedValueOnce('SETUP_NEEDED').mockResolvedValueOnce({ id: '9', username: 'mia_x', name: 'Mia' });
    const user = userEvent.setup();
    render(<Connections onNavigate={vi.fn()} accounts={accounts} brands={brands}/>);
    await within(row('Instagram @massagewithmia')).findByText('Connected');
    await user.click(within(row('X @mia_x')).getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: /Copy the client ID$/ }));
    const form = await screen.findByRole('form', { name: 'X keys' });
    await user.type(within(form).getByLabelText('OAuth 2.0 Client ID'), 'abc-123');
    await user.click(within(form).getByRole('button', { name: 'Save and connect' }));
    expect(apps.saveDeveloperApp).toHaveBeenCalledWith('x', 'abc-123', '');
    expect(x.connectX).toHaveBeenLastCalledWith('', 'x-mia', 'mia_x');
    expect(await screen.findByText('X connected as @mia_x for Massage With Mia.')).toBeInTheDocument();
  });
  it('asks for the TikTok app once, then connects that TikTok profile with its saved sign-in', async () => {
    vi.mocked(social.connectTiktok).mockRejectedValueOnce('SETUP_NEEDED').mockResolvedValueOnce({ id: 'open-1', username: 'mia', name: 'Mia' });
    const user = userEvent.setup();
    render(<Connections onNavigate={vi.fn()} accounts={accounts} brands={brands}/>);
    await within(row('Instagram @massagewithmia')).findByText('Connected');
    await user.click(within(row('TikTok @mia')).getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: /Copy the client key and secret/ }));
    const form = await screen.findByRole('form', { name: 'TikTok keys' });
    await user.type(within(form).getByLabelText('Client key'), 'awkey123');
    await user.type(within(form).getByLabelText('Client secret'), 'secret-value-123');
    await user.click(within(form).getByRole('button', { name: 'Save and connect' }));
    expect(apps.saveDeveloperApp).toHaveBeenCalledWith('tiktok', 'awkey123', 'secret-value-123');
    expect(social.connectTiktok).toHaveBeenLastCalledWith('tt-mia', 'mia');
    expect(await screen.findByText('TikTok connected as @mia for Massage With Mia.')).toBeInTheDocument();
  });
});

