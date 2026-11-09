import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Connections, { postingConnected } from './Connections';
import type { Account } from './model';

vi.mock('./emailService', () => ({ emailConnection: vi.fn(async () => ({ host: 'gmail', username: 'softwings25@gmail.com', kind: 'gmail' })), connectGmailSession: vi.fn(), openGmailSignIn: vi.fn() }));
vi.mock('./instagramService', () => ({ instagramConnection: vi.fn(async () => ({ id: '1', username: 'softwings' })) }));
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
});
