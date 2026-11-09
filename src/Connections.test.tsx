import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Connections, { postingConnected } from './Connections';
import type { Account } from './model';
import * as instagram from './instagramService';

vi.mock('./emailService', () => ({ emailConnection: vi.fn(async () => ({ host: 'gmail', username: 'softwings25@gmail.com', kind: 'gmail' })), connectGmailSession: vi.fn(), openGmailSignIn: vi.fn() }));
vi.mock('./instagramService', () => ({ INSTAGRAM_REDIRECT_URI: 'https://localhost/socialspace/instagram', instagramConnection: vi.fn(async () => ({ id: '1', username: 'softwings' })), connectInstagramApp: vi.fn(), saveInstagramApp: vi.fn() }));
vi.mock('./xService', () => ({ xConnection: vi.fn(async () => null) }));
vi.mock('./videoSourcesService', () => ({ listVideoSources: vi.fn(async () => ({ active: null, sources: [] })) }));
afterEach(cleanup);

describe('connections', () => {
  it('shows what is connected and sends you to connect the rest', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<Connections onNavigate={onNavigate}/>);
    const list = screen.getByRole('region', { name: 'Connections' });
    expect(await within(list).findByText('Connected · softwings25@gmail.com')).toBeInTheDocument();
    expect(within(list).getByText('Connected · @softwings')).toBeInTheDocument();
    expect(within(list).getAllByText('Not connected')).toHaveLength(2);
    await user.click(within(list).getAllByRole('button', { name: 'Connect' })[0]);
    expect(onNavigate).toHaveBeenCalledWith('publishing');
  });

  it('knows which profile the app can post for', () => {
    const profile = (handle: string): Account => ({ id: handle, platform: 'instagram', label: 'Mia', handle, status: 'active', notes: '' });
    const state = { inbox: null, instagram: 'SoftWings', x: null, videoSources: 0 };
    expect(postingConnected(profile('softwings'), state)).toBe(true);
    expect(postingConnected(profile('massagewithmia'), state)).toBe(false);
  });
  it('connects Instagram in one click, asking for the Meta app only the first time', async () => {
    vi.mocked(instagram.instagramConnection).mockResolvedValue(null);
    vi.mocked(instagram.connectInstagramApp).mockRejectedValueOnce('SETUP_NEEDED').mockResolvedValueOnce({ id: '9', username: 'softwings' });
    const live: Account = { id: 'ig1', platform: 'instagram', label: 'Mia', handle: 'softwings', status: 'active', notes: '' };
    const user = userEvent.setup();
    render(<Connections onNavigate={vi.fn()} accounts={[live]}/>);
    const row = (await screen.findByText('Instagram posting')).closest('.connection-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Connect' }));
    expect(instagram.connectInstagramApp).toHaveBeenCalledWith('ig1', 'softwings');
    const form = await screen.findByRole('form', { name: 'Set up Instagram once' });
    await user.type(within(form).getByLabelText('Instagram App ID'), '1234567890');
    await user.type(within(form).getByLabelText('Instagram App Secret'), 'abcdef0123456789abcdef0123456789');
    await user.click(within(form).getByRole('button', { name: 'Save and connect' }));
    expect(instagram.saveInstagramApp).toHaveBeenCalledWith('1234567890', 'abcdef0123456789abcdef0123456789');
    expect(await screen.findByText('Instagram connected as @softwings.')).toBeInTheDocument();
  });
});
