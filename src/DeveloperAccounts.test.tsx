import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeveloperAccounts from './DeveloperAccounts';
import { setAccountPassword } from './profileService';
import { saveDeveloperApp } from './devAppsService';

vi.mock('./profileService', () => ({ onPasswordSaved: () => () => undefined, hasAccountPassword: vi.fn(async (id: string) => id === 'developer-x'), revealAccountPassword: vi.fn(async () => 'secret-x'), setAccountPassword: vi.fn(async () => undefined), exportSignIns: vi.fn(), importSignIns: vi.fn() }));
vi.mock('./devAppsService', () => ({ listDeveloperApps: vi.fn(async () => [{ provider: 'x', id: 'x-client-id' }, { provider: 'tiktok', id: null }]), saveDeveloperApp: vi.fn(async () => undefined) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('developer accounts', () => {
  it('shows one card per social on the main email, with saved app IDs', async () => {
    render(<DeveloperAccounts/>);
    for (const name of ['TikTok for Developers', 'Google Cloud (YouTube)', 'X Developer', 'Meta for Developers']) {
      expect(within(screen.getByLabelText(name)).getByText('softwings25@gmail.com')).toBeInTheDocument();
    }
    expect(await within(screen.getByLabelText('X Developer')).findByText('x-client-id')).toBeInTheDocument();
    expect(within(screen.getByLabelText('TikTok for Developers')).getByText('Not saved yet')).toBeInTheDocument();
  });

  it('saves a typed password under the developer account, not a brand profile', async () => {
    const user = userEvent.setup();
    render(<DeveloperAccounts/>);
    const tiktok = screen.getByLabelText('TikTok for Developers');
    await user.type(await within(tiktok).findByLabelText('New password for TikTok for Developers'), 'Typed-Pass-1');
    await user.click(within(tiktok).getByRole('button', { name: 'Save' }));
    expect(setAccountPassword).toHaveBeenCalledWith('developer-tiktok', 'Typed-Pass-1');
  });

  it('saves app keys for its own social', async () => {
    const user = userEvent.setup();
    render(<DeveloperAccounts/>);
    const meta = screen.getByLabelText('Meta for Developers');
    await user.click(within(meta).getByRole('button', { name: /Add keys/ }));
    await user.type(within(meta).getByLabelText('App ID'), '12345');
    await user.type(within(meta).getByLabelText('App secret'), 'abc');
    await user.click(within(meta).getByRole('button', { name: 'Save keys' }));
    expect(saveDeveloperApp).toHaveBeenCalledWith('meta', '12345', 'abc');
  });
});

describe('developer app reviews', () => {
  it('shows each review state and saves one chosen by hand', async () => {
    const user = userEvent.setup();
    const onSet = vi.fn();
    render(<DeveloperAccounts reviews={{ marks: { 'review:google:submitted': Date.parse('2026-11-10T12:00:00Z') }, onSet }}/>);
    expect(within(screen.getByLabelText('X Developer')).getByText('None needed')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Google Cloud (YouTube)')).getByLabelText('YouTube API audit status')).toHaveValue('submitted');
    await user.selectOptions(within(screen.getByLabelText('TikTok for Developers')).getByLabelText('TikTok app review status'), 'submitted');
    expect(onSet).toHaveBeenCalledWith('tiktok', 'submitted');
  });
});

describe('test mode on developer accounts', () => {
  it('marks TikTok and YouTube as test, and Meta review as not needed', () => {
    render(<DeveloperAccounts reviews={{ marks: {}, onSet: () => undefined }}/>);
    expect(within(screen.getByLabelText('TikTok for Developers')).getByText('Test · Sandbox')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Google Cloud (YouTube)')).getByText('Test · Testing')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Meta for Developers')).getByText('Not needed for your accounts')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Meta for Developers')).queryByText(/^Test/)).not.toBeInTheDocument();
  });
});
