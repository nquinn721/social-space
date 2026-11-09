import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreateAccountWizard, { DEFAULT_SIGNUP_EMAIL } from './CreateAccountWizard';
import * as profile from './profileService';
import * as email from './emailService';
import * as suggest from './assistant/suggest';
import * as imageAi from './imageAiService';
import type { Account } from './model';

vi.mock('./profileService', async (original) => ({ ...(await original<typeof import('./profileService')>()),
  embedPlatformPage: vi.fn(), setEmbeddedBounds: vi.fn(), closeEmbeddedPage: vi.fn(), fillSiteForm: vi.fn(), openGmailSignup: vi.fn(), ensureSharedPassword: vi.fn(), revealAccountPassword: vi.fn(), chooseImageFile: vi.fn(), loadImagePreview: vi.fn() }));
vi.mock('./assistant/suggest', () => ({ suggestProfile: vi.fn() }));
vi.mock('./imageAiService', async (original) => ({ ...(await original<typeof import('./imageAiService')>()), imageAiStatus: vi.fn(), startImageAi: vi.fn(), generateProfileImage: vi.fn() }));
vi.mock('./emailService', () => ({ emailConnection: vi.fn(), listEmails: vi.fn(), readEmail: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(profile.embedPlatformPage).mockResolvedValue('site-embed-4');
  vi.mocked(profile.setEmbeddedBounds).mockResolvedValue();
  vi.mocked(profile.closeEmbeddedPage).mockResolvedValue();
  vi.mocked(email.emailConnection).mockResolvedValue({ host: 'imap.gmail.com', username: DEFAULT_SIGNUP_EMAIL });
  vi.mocked(email.listEmails).mockResolvedValue([{ uid: 9, from: 'Instagram <security@mail.instagram.com>', subject: '482913 is your Instagram code', date: 'today', unread: true }]);
  vi.mocked(email.readEmail).mockResolvedValue({ uid: 9, from: 'Instagram', to: DEFAULT_SIGNUP_EMAIL, subject: '482913 is your Instagram code', date: 'today', body: 'Confirm your email address. Your code is 482913.' });
});
afterEach(cleanup);

describe('create account wizard', () => {
  it('creates the same account on every social in turn with one shared password', async () => {
    const saved: Account[] = [];
    const onSave = vi.fn(async (account: Account) => { saved.push(account); });
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={onSave} onClose={vi.fn()}/>);
    for (const name of ['Instagram', 'TikTok', 'YouTube', 'X']) expect(screen.getByLabelText(name)).toBeChecked();
    expect(screen.getByLabelText('Sign-up email')).toHaveValue(DEFAULT_SIGNUP_EMAIL);
    expect(screen.getByText('0/80 (TikTok limit)')).toBeInTheDocument();
    await user.click(screen.getByLabelText('YouTube'));
    await user.type(screen.getByLabelText('Account name'), 'Soft Wings');
    await user.type(screen.getByLabelText('Username you want optional'), '@softwings');
    await user.type(screen.getByLabelText(/Profile description/), 'Wings for little dreamers.');
    await user.click(screen.getByRole('button', { name: /Start with 3 socials/ }));

    expect(await screen.findByText('Now: Instagram (1 of 3)')).toBeInTheDocument();
    expect(saved.map((item) => item.platform)).toEqual(['instagram', 'tiktok', 'x']);
    expect(saved.every((item) => item.handle === 'softwings' && item.bio === 'Wings for little dreamers.' && item.signupEmail === DEFAULT_SIGNUP_EMAIL)).toBe(true);
    expect(profile.ensureSharedPassword).toHaveBeenCalledWith(saved.map((item) => item.id));
    expect(profile.embedPlatformPage).toHaveBeenLastCalledWith('instagram', 'create', expect.objectContaining({ x: 0, y: 0 }));
    await waitFor(() => expect(profile.fillSiteForm).toHaveBeenLastCalledWith('site-embed-4', expect.objectContaining({ username: 'softwings' }), { accountId: saved[0].id, includePassword: true, keepFilling: true }));

    await user.click(await screen.findByRole('button', { name: /482913 is your Instagram code/ }));
    await user.click(await screen.findByRole('button', { name: 'Fill on page' }));
    expect(vi.mocked(profile.fillSiteForm).mock.calls.at(-1)?.[1]).toMatchObject({ verificationCode: '482913' });

    await user.click(screen.getByRole('button', { name: 'Instagram account is created, next' }));
    expect(await screen.findByText('Now: TikTok (2 of 3)')).toBeInTheDocument();
    await waitFor(() => expect(profile.embedPlatformPage).toHaveBeenLastCalledWith('tiktok', 'create', expect.anything()));
    await user.click(screen.getByRole('button', { name: /Skip TikTok/ }));
    await user.click(await screen.findByRole('button', { name: 'X account is created' }));

    expect(await screen.findByText(/Created on Instagram, X\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fill Instagram profile/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fill TikTok profile/ })).not.toBeInTheDocument();
    const statuses = Object.fromEntries(saved.map((item) => [item.platform, item.status]));
    expect(statuses).toEqual({ instagram: 'active', tiktok: 'planned', x: 'active' });
    expect(profile.closeEmbeddedPage).toHaveBeenCalled();
  });

  it('suggests a name and description from an idea', async () => {
    vi.mocked(suggest.suggestProfile).mockResolvedValue({ name: 'Flutter Finds', username: 'flutterfinds', displayName: 'Flutter Finds', description: 'Butterfly jewelry kids love.', imagePrompt: 'pastel butterfly logo mark', imageStyle: 'logo' });
    vi.mocked(imageAi.imageAiStatus).mockResolvedValue({ running: true, looks: ['fast', 'detailed'], canStart: true });
    vi.mocked(imageAi.generateProfileImage).mockResolvedValue({ path: 'C:\\pics\\profile-1.png', seed: 1, preview: 'data:image/png;base64,1' });
    vi.mocked(profile.loadImagePreview).mockResolvedValue('data:image/png;base64,1');
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText(/Your idea/), 'butterfly jewelry for kids');
    await user.click(screen.getByRole('button', { name: /Suggest/ }));
    expect(await screen.findByText(/Suggested by your local model/)).toBeInTheDocument();
    expect(screen.getByLabelText('Account name')).toHaveValue('Flutter Finds');
    expect(screen.getByLabelText('Username you want optional')).toHaveValue('flutterfinds');
    expect(screen.getByLabelText(/Profile description/)).toHaveValue('Butterfly jewelry kids love.');
    expect(suggest.suggestProfile).toHaveBeenCalledWith('butterfly jewelry for kids', 80, ['Instagram', 'TikTok', 'YouTube', 'X']);
    // The matching picture is made straight away and becomes the account's image.
    expect(await screen.findByText('profile-1.png')).toBeInTheDocument();
    expect(vi.mocked(imageAi.generateProfileImage).mock.calls[0][0].prompt).toBe('minimal modern logo mark, pastel butterfly logo mark, flat vector style, bold simple shapes, centered on a plain background, high contrast, app icon');
  });

  it('keeps one description within the tightest chosen limit', async () => {
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()} initialPlatforms={['youtube']}/>);
    expect(screen.getByLabelText('Instagram')).not.toBeChecked();
    await user.type(screen.getByLabelText('Account name'), 'Clips');
    await user.click(screen.getByLabelText('TikTok'));
    await user.type(screen.getByLabelText(/Profile description/), 'a'.repeat(81));
    expect(screen.getByRole('button', { name: /Start with 2 socials/ })).toBeDisabled();
  });
});

describe('verification code detection', () => {
  it('prefers the number next to the word code', () => {
    expect(profile.findCode('Order 2024 shipped. Your verification code: 771204')).toBe('771204');
    expect(profile.findCode('Use 5521 to sign in')).toBe('5521');
    expect(profile.findCode('No digits here')).toBeNull();
  });

  it('starts from the details of an existing brand', () => {
    render(<CreateAccountWizard initialPlatforms={['tiktok']} prefill={{ label: 'Soft Wings', handle: 'softwings', bio: 'Wings.' }} onSave={vi.fn()} onClose={vi.fn()}/>);
    expect(screen.getByLabelText('Account name')).toHaveValue('Soft Wings');
    expect(screen.getByLabelText('Username you want optional')).toHaveValue('softwings');
    expect(screen.getByLabelText('Sign-up email')).toHaveValue(DEFAULT_SIGNUP_EMAIL);
    expect(screen.getByLabelText('Instagram')).not.toBeChecked();
  });

  it('saves the birthday so sign-up forms can fill it', async () => {
    const saved: Account[] = [];
    const user = userEvent.setup();
    render(<CreateAccountWizard initialPlatforms={['instagram']} onSave={async (account) => { saved.push(account); }} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'Soft Wings');
    await user.type(screen.getByLabelText(/Birthday/), '1998-04-12');
    await user.click(screen.getByRole('button', { name: /Start with 1 social/ }));
    await waitFor(() => expect(vi.mocked(profile.fillSiteForm).mock.calls.at(-1)?.[1]).toMatchObject({ birthday: '1998-04-12' }));
    expect(saved[0].birthday).toBe('1998-04-12');
  });

  it('goes straight to the sign-up page of a planned account', async () => {
    const planned: Account = { id: 'p1', platform: 'instagram', label: 'MassageMentor', handle: 'massagelisa', status: 'planned', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL };
    render(<CreateAccountWizard resume={[planned]} onSave={vi.fn()} onClose={vi.fn()}/>);
    expect(screen.getByText('Now: Instagram (1 of 1)')).toBeInTheDocument();
    await waitFor(() => expect(profile.embedPlatformPage).toHaveBeenCalledWith('instagram', 'create', expect.anything()));
    expect(profile.ensureSharedPassword).toHaveBeenCalledWith(['p1']);
    await waitFor(() => expect(profile.fillSiteForm).toHaveBeenLastCalledWith('site-embed-4', expect.objectContaining({ username: 'massagelisa', email: DEFAULT_SIGNUP_EMAIL }), { accountId: 'p1', includePassword: true, keepFilling: true }));
  });

  it('fills a code straight from the inbox list', async () => {
    const user = userEvent.setup();
    render(<CreateAccountWizard initialPlatforms={['instagram']} onSave={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'Soft Wings');
    await user.click(screen.getByRole('button', { name: /Start with 1 social/ }));
    await user.click(await screen.findByRole('button', { name: 'Fill code 482913 on page' }));
    await waitFor(() => expect(vi.mocked(profile.fillSiteForm).mock.calls.at(-1)?.[1]).toMatchObject({ verificationCode: '482913' }));
  });
  it('adds Instagram to the shared login and gives TikTok its own email when the base one is taken', async () => {
    const saved: Account[] = [];
    const existing: Account[] = [{ id: 'old-ig', platform: 'instagram', label: 'MassageMentor', handle: 'massagelisa', status: 'planned', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL }, { id: 'old-tt', platform: 'tiktok', label: 'MassageMentor', handle: 'massagelisa', status: 'planned', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL }];
    const user = userEvent.setup();
    render(<CreateAccountWizard initialPlatforms={['instagram', 'tiktok']} existing={existing} prefill={{ brandId: 'brand-mia' }} onSave={async (account) => { saved.push(account); }} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'Massage With Mia');
    const plan = screen.getByRole('list', { name: 'Login plan' });
    expect(plan).toHaveTextContent('Adds to your Instagram login softwings25@gmail.com (2 of 5 profiles).');
    expect(plan).toHaveTextContent('New TikTok account with its own email softwings25+massagewithmia@gmail.com.');
    await user.click(screen.getByRole('button', { name: /Start with 2 socials/ }));
    await screen.findByText('Now: Instagram (1 of 2)');
    expect(saved.map((item) => [item.platform, item.signupEmail, item.brandId])).toEqual([['instagram', DEFAULT_SIGNUP_EMAIL, 'brand-mia'], ['tiktok', 'softwings25+massagewithmia@gmail.com', 'brand-mia']]);
    expect(saved.every((item) => item.handle === 'massagewithmia' && item.displayName === 'Massage With Mia')).toBe(true);
  });
  it('opens Google sign-up with the brand filled in for an optional new Gmail', async () => {
    vi.mocked(profile.openGmailSignup).mockResolvedValue('site-9');
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'Massage With Mia');
    await user.click(screen.getByRole('button', { name: 'Make a new Gmail instead' }));
    await waitFor(() => expect(profile.fillSiteForm).toHaveBeenCalledWith('site-9', { firstName: 'Massage With Mia', username: 'massagewithmia' }, { keepFilling: true }));
  });
});
