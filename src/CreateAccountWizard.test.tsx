import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreateAccountWizard, { DEFAULT_SIGNUP_EMAIL } from './CreateAccountWizard';
import * as profile from './profileService';
import * as email from './emailService';
import type { Account } from './model';

vi.mock('./profileService', async (original) => ({ ...(await original<typeof import('./profileService')>()),
  openPlatformWindow: vi.fn(), fillSiteForm: vi.fn(), ensureAccountPassword: vi.fn(), revealAccountPassword: vi.fn(), chooseImageFile: vi.fn(), loadImagePreview: vi.fn() }));
vi.mock('./emailService', () => ({ emailConnection: vi.fn(), listEmails: vi.fn(), readEmail: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(profile.openPlatformWindow).mockResolvedValue('site-4');
  vi.mocked(email.emailConnection).mockResolvedValue({ host: 'imap.gmail.com', username: DEFAULT_SIGNUP_EMAIL });
  vi.mocked(email.listEmails).mockResolvedValue([{ uid: 9, from: 'Instagram <security@mail.instagram.com>', subject: '482913 is your Instagram code', date: 'today', unread: true }]);
  vi.mocked(email.readEmail).mockResolvedValue({ uid: 9, from: 'Instagram', to: DEFAULT_SIGNUP_EMAIL, subject: '482913 is your Instagram code', date: 'today', body: 'Confirm your email address. Your code is 482913.' });
});
afterEach(cleanup);

describe('create account wizard', () => {
  it('saves the account, makes a password, opens sign-up, fills it, and fills the emailed code', async () => {
    const saved: Account[] = [];
    const onSave = vi.fn(async (account: Account) => { saved.push(account); });
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={onSave} onClose={vi.fn()}/>);
    expect(screen.getByLabelText('Sign-up email')).toHaveValue(DEFAULT_SIGNUP_EMAIL);
    await user.type(screen.getByLabelText('Account name'), 'Soft Wings');
    await user.type(screen.getByLabelText('Username you want optional'), '@softwings');
    await user.click(screen.getByRole('button', { name: /Open Instagram sign-up/ }));

    expect(await screen.findByText(/sign-up window is open/)).toBeInTheDocument();
    const account = saved[0];
    expect(account).toMatchObject({ platform: 'instagram', label: 'Soft Wings', handle: 'softwings', signupEmail: DEFAULT_SIGNUP_EMAIL, status: 'planned' });
    expect(profile.ensureAccountPassword).toHaveBeenCalledWith(account.id);
    expect(profile.openPlatformWindow).toHaveBeenCalledWith('instagram', 'create');
    expect(profile.fillSiteForm).toHaveBeenCalledWith('site-4', expect.objectContaining({ email: DEFAULT_SIGNUP_EMAIL, username: 'softwings' }), { accountId: account.id, includePassword: true, keepFilling: true });

    await user.click(await screen.findByRole('button', { name: /482913 is your Instagram code/ }));
    expect(await screen.findByText('482913', { selector: 'strong' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fill on page' }));
    expect(vi.mocked(profile.fillSiteForm).mock.calls.at(-1)?.[1]).toMatchObject({ verificationCode: '482913' });

    await user.click(screen.getByRole('button', { name: 'My account is created' }));
    expect(saved.at(-1)).toMatchObject({ id: account.id, status: 'active' });
    expect(await screen.findByRole('button', { name: /Open profile settings and fill/ })).toBeInTheDocument();
  });

  it('keeps the bio within the platform limit', async () => {
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()} initialPlatform="tiktok"/>);
    await user.type(screen.getByLabelText('Account name'), 'Clips');
    await user.type(screen.getByLabelText(/Profile description/), 'a'.repeat(81));
    expect(screen.getByRole('button', { name: /Open TikTok sign-up/ })).toBeDisabled();
  });
});

describe('verification code detection', () => {
  it('prefers the number next to the word code', () => {
    expect(profile.findCode('Order 2024 shipped. Your verification code: 771204')).toBe('771204');
    expect(profile.findCode('Use 5521 to sign in')).toBe('5521');
    expect(profile.findCode('No digits here')).toBeNull();
  });
});
