import '@testing-library/jest-dom/vitest';
import { cleanup, within, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CreateAccountWizard, { DEFAULT_SIGNUP_EMAIL } from './CreateAccountWizard';
import * as profile from './profileService';
import * as email from './emailService';
import * as suggest from './assistant/suggest';
import * as brandIdeas from './assistant/brandIdeas';
import * as imageAi from './imageAiService';
import type { Account } from './model';

vi.mock('./profileService', async (original) => ({ ...(await original<typeof import('./profileService')>()),
  embedPlatformPage: vi.fn(), setEmbeddedBounds: vi.fn(), closeEmbeddedPage: vi.fn(), fillSiteForm: vi.fn(), openGmailSignup: vi.fn(), ensureAccountPassword: vi.fn(), ensureSharedPassword: vi.fn(), revealAccountPassword: vi.fn(), chooseImageFile: vi.fn(), loadImagePreview: vi.fn() }));
vi.mock('./assistant/suggest', () => ({ suggestProfile: vi.fn() }));
vi.mock('./assistant/brandIdeas', () => ({ suggestBrandIdeas: vi.fn() }));
vi.mock('./imageAiService', async (original) => ({ ...(await original<typeof import('./imageAiService')>()), generateProfileImage: vi.fn() }));
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
  it('plans separate accounts and passwords on each social', async () => {
    const saved: Account[] = [];
    const onSave = vi.fn(async (account: Account) => { saved.push(account); });
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={onSave} onClose={vi.fn()}/>);
    for (const name of ['Instagram', 'TikTok', 'YouTube', 'X', 'Facebook']) expect(screen.getByLabelText(name)).toBeChecked();
    expect(screen.getByLabelText('Sign-up email')).toHaveValue(DEFAULT_SIGNUP_EMAIL);
    expect(screen.getByText('0/80 (TikTok limit)')).toBeInTheDocument();
    await user.click(screen.getByLabelText('YouTube'));
    await user.click(screen.getByLabelText('Facebook'));
    await user.type(screen.getByLabelText('Account name'), 'Soft Wings');
    await user.type(screen.getByLabelText('Username you want optional'), '@softwings');
    await user.type(screen.getByLabelText(/Profile description/), 'Wings for little dreamers.');
    await user.click(screen.getByRole('button', { name: /Start with 3 socials/ }));

    expect(await screen.findByText('Now: Instagram (1 of 3)')).toBeInTheDocument();
    expect(saved.map((item) => item.platform)).toEqual(['instagram', 'tiktok', 'x']);
    expect(saved.every((item) => item.handle === 'softwings' && item.bio === 'Wings for little dreamers.')).toBe(true);
    // Addresses are aliases into the inbox; each social account gets its own password.
    expect(saved.map((item) => item.signupEmail)).toEqual(Array(3).fill('softwings25+softwings@gmail.com'));
    expect(vi.mocked(profile.ensureAccountPassword).mock.calls.map(([id]) => id)).toEqual(saved.map((item) => item.id));
    expect(profile.ensureSharedPassword).not.toHaveBeenCalled();
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

  it('lets you choose and reroll ideas before filling the form', async () => {
    vi.mocked(suggest.suggestProfile).mockResolvedValue({ name: 'Flutter Finds', username: 'flutterfinds', displayName: 'Flutter Finds', description: 'Butterfly jewelry kids love.', imagePrompt: 'pastel butterfly logo mark', imageStyle: 'logo' });
    vi.mocked(brandIdeas.suggestBrandIdeas)
      .mockResolvedValueOnce(['Idea one', 'Idea two', 'Idea three', 'Idea four', 'Idea five'])
      .mockResolvedValueOnce(['Fresh second idea'])
      .mockResolvedValueOnce(['New one', 'New two', 'New three', 'New four', 'New five']);
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByRole('button', { name: /Idea one/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Idea five/ })).toBeInTheDocument();
    expect(brandIdeas.suggestBrandIdeas).toHaveBeenCalledWith({ context: '', exclude: [], count: 5 });
    await user.click(screen.getByRole('button', { name: 'Reroll suggestion 2' }));
    expect(await screen.findByRole('button', { name: /Fresh second idea/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Idea one/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Idea five/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reroll all' }));
    await user.click(await screen.findByRole('button', { name: /New three/ }));
    expect(screen.queryByRole('dialog', { name: 'Find your idea' })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Your idea/)).toHaveValue('New three');
    expect(screen.getByLabelText('Account name')).toHaveValue('');
    expect(suggest.suggestProfile).not.toHaveBeenCalled();
    expect(imageAi.generateProfileImage).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Fill form' }));
    expect(await screen.findByText(/Form filled/)).toBeInTheDocument();
    expect(screen.getByLabelText('Account name')).toHaveValue('Flutter Finds');
    expect(screen.getByLabelText('Username you want optional')).toHaveValue('flutterfinds');
    expect(screen.getByLabelText(/Profile description/)).toHaveValue('Butterfly jewelry kids love.');
    expect(suggest.suggestProfile).toHaveBeenCalledWith('New three', 80, ['Instagram', 'TikTok', 'YouTube', 'X', 'Facebook']);
    expect(imageAi.generateProfileImage).not.toHaveBeenCalled();
  });

  it('starts the picture from the filled brand, not a generic portrait', async () => {
    vi.mocked(suggest.suggestProfile).mockResolvedValue({ name: 'Bunny Whispers', username: 'bunnywhispers', displayName: 'Bunny Whispers | Quotes', description: 'Gentle bunny quotes for kids 3-8', imagePrompt: 'cute illustrated bunny with a soft smile, pastel meadow', imageStyle: 'illustration' });
    vi.mocked(imageAi.generateProfileImage).mockResolvedValue({ path: 'C:\\pics\\bunny.jpg', preview: 'data:image/jpeg;base64,1' });
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText(/Your idea/), 'bunny quotes for kids');
    await user.click(screen.getByRole('button', { name: 'Fill form' }));
    expect(await screen.findByText(/Form filled/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /Generate/ })[0]);
    expect(screen.getByLabelText('Describe the picture')).toHaveValue('cute illustrated bunny with a soft smile, pastel meadow');
    expect(screen.getByRole('button', { name: 'Illustrated avatar' })).toHaveAttribute('aria-pressed', 'true');
    const studio = screen.getByRole('region', { name: 'Generate a profile picture' });
    await user.click(within(studio).getByRole('button', { name: /^Generate$/ }));
    const prompt = vi.mocked(imageAi.generateProfileImage).mock.calls[0][0].prompt;
    expect(prompt).toMatch(/Bunny Whispers \| Quotes/);
    expect(prompt).toMatch(/no human faces/);
    expect(prompt).not.toMatch(/fictional person/);
  });

  it('keeps provider errors retryable and does not close the wizard on Escape', async () => {
    vi.mocked(brandIdeas.suggestBrandIdeas).mockRejectedValueOnce(new Error('Add your xAI key in Settings.'))
      .mockResolvedValueOnce(['One', 'Two', 'Three', 'Four', 'Five']);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={onClose}/>);
    await user.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add your xAI key in Settings.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^One/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Find your idea' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a fill error next to the idea and lets you retry', async () => {
    vi.mocked(suggest.suggestProfile).mockRejectedValueOnce(new Error('Check the xAI key.'))
      .mockResolvedValueOnce({ name: 'Bright Ideas', username: 'brightideas', displayName: 'Bright Ideas', description: 'A bright new idea.', imagePrompt: '', imageStyle: 'photo' });
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText(/Your idea/), 'An art studio');
    await user.click(screen.getByRole('button', { name: 'Fill form' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the xAI key.');
    await user.click(screen.getByRole('button', { name: 'Fill form' }));
    expect(await screen.findByText(/Form filled/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Account name')).toHaveValue('Bright Ideas');
  });

  it('prevents form edits while a fill request is in flight', async () => {
    let finish!: (value: Awaited<ReturnType<typeof suggest.suggestProfile>>) => void;
    vi.mocked(suggest.suggestProfile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText(/Your idea/), 'A garden studio');
    await user.click(screen.getByRole('button', { name: 'Fill form' }));
    expect(screen.getByLabelText(/Your idea/)).toBeDisabled();
    expect(screen.getByLabelText('Instagram')).toBeDisabled();
    expect(screen.getByLabelText('Account name')).toBeDisabled();
    expect(screen.getByLabelText('Username you want optional')).toBeDisabled();
    expect(screen.getByLabelText('Display name optional')).toBeDisabled();
    expect(screen.getByLabelText(/Profile description/)).toBeDisabled();
    finish({ name: 'Garden Studio', username: 'gardenstudio', displayName: 'Garden Studio', description: 'Growing together.', imagePrompt: '', imageStyle: 'photo' });
    await waitFor(() => expect(screen.getByLabelText('Account name')).toBeEnabled());
    expect(screen.getByLabelText('Account name')).toHaveValue('Garden Studio');
  });

  it('ignores an older request after the suggestions are closed and reopened', async () => {
    let finishFirst!: (ideas: string[]) => void;
    vi.mocked(brandIdeas.suggestBrandIdeas)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(['Fresh one', 'Fresh two', 'Fresh three', 'Fresh four', 'Fresh five']);
    const user = userEvent.setup();
    render(<CreateAccountWizard onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(screen.getByText('Finding ideas…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close suggestions' }));
    await user.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(await screen.findByRole('button', { name: /Fresh one/ })).toBeInTheDocument();
    finishFirst(['Old one', 'Old two', 'Old three', 'Old four', 'Old five']);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Old one/ })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Fresh five/ })).toBeInTheDocument();
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
  it('opens a planned X account without filling any X form', async () => {
    const planned: Account = { id: 'p-x', platform: 'x', label: 'Mia', handle: 'mia', status: 'planned', notes: '', signupEmail: 'mia+x@example.com' };
    render(<CreateAccountWizard resume={[planned]} onSave={vi.fn()} onClose={vi.fn()}/>);
    await waitFor(() => expect(profile.embedPlatformPage).toHaveBeenCalledWith('x', 'create', expect.anything()));
    expect(profile.fillSiteForm).not.toHaveBeenCalled();
    expect(await screen.findByText(/Enter the details on X yourself/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Fill this page again/ })).not.toBeInTheDocument();
  });
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
    // No date is guessed: the user supplies it if needed.
    expect(screen.getByLabelText(/Birthday/)).toHaveValue('');
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
    expect(profile.ensureAccountPassword).toHaveBeenCalledWith('p1');
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
  it('copies the code, shows it bottom right, and lists the real sign-up steps', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CreateAccountWizard initialPlatforms={['tiktok']} onSave={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'Soft Wings');
    await user.click(screen.getByRole('button', { name: /Start with 1 social/ }));
    const steps = await screen.findByRole('list', { name: 'TikTok sign-up steps' });
    expect(steps).toHaveTextContent('Finish in the TikTok app');
    await user.click(await screen.findByRole('button', { name: 'Fill code 482913 on page' }));
    await waitFor(() => expect(document.querySelector('.code-toast')).toHaveTextContent('482913'));
    // The code is copied as soon as it arrives, and typed into the page.
    expect(writeText).toHaveBeenCalledWith('482913');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(profile.fillSiteForm).mock.calls.at(-1)?.[1]).toMatchObject({ verificationCode: '482913' }));
  });
  it('starts fresh Instagram and TikTok accounts when another brand exists', async () => {
    const saved: Account[] = [];
    const existing: Account[] = [{ id: 'old-ig', platform: 'instagram', label: 'MassageMentor', handle: 'massagelisa', status: 'planned', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL }, { id: 'old-tt', platform: 'tiktok', label: 'MassageMentor', handle: 'massagelisa', status: 'planned', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL }];
    const user = userEvent.setup();
    render(<CreateAccountWizard initialPlatforms={['instagram', 'tiktok']} existing={existing} prefill={{ brandId: 'brand-mia' }} onSave={async (account) => { saved.push(account); }} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'Massage With Mia');
    const plan = screen.getByRole('list', { name: 'Login plan' });
    expect(plan).toHaveTextContent('Plan a separate Instagram account with softwings25+massagewithmia@gmail.com; this plus-address uses your existing inbox if supported. Confirm the platform accepts it.');
    expect(plan).toHaveTextContent('Plan a separate TikTok account with softwings25+massagewithmia@gmail.com; this plus-address uses your existing inbox if supported. Confirm the platform accepts it.');
    await user.click(screen.getByRole('button', { name: /Start with 2 socials/ }));
    await screen.findByText('Now: Instagram (1 of 2)');
    expect(saved.map((item) => [item.platform, item.signupEmail, item.brandId])).toEqual([['instagram', 'softwings25+massagewithmia@gmail.com', 'brand-mia'], ['tiktok', 'softwings25+massagewithmia@gmail.com', 'brand-mia']]);
    expect(saved.every((item) => item.handle === 'massagewithmia' && item.displayName === 'Massage With Mia')).toBe(true);
    await waitFor(() => expect(profile.embedPlatformPage).toHaveBeenLastCalledWith('instagram', 'create', expect.anything()));
    expect(screen.getByRole('list', { name: 'Instagram sign-up steps' })).toHaveTextContent('Sign-up form');
    await user.click(screen.getByRole('button', { name: /Instagram account is created, next/ }));
    await waitFor(() => expect(profile.embedPlatformPage).toHaveBeenLastCalledWith('tiktok', 'create', expect.anything()));
  });
  it('opens the add-channel flow for the first YouTube channel without generating a Google password', async () => {
    const user = userEvent.setup();
    render(<CreateAccountWizard initialPlatforms={['youtube']} onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'First brand');
    await user.click(screen.getByRole('button', { name: /Start with 1 social/ }));
    await waitFor(() => expect(profile.embedPlatformPage).toHaveBeenCalledWith('youtube', 'addProfile', expect.anything()));
    await waitFor(() => expect(profile.fillSiteForm).toHaveBeenCalledWith('site-embed-4', { channelName: 'First brand' }, expect.objectContaining({ includePassword: false })));
    await user.click(screen.getByRole('button', { name: 'Fill this page again' }));
    expect(vi.mocked(profile.fillSiteForm).mock.calls.at(-1)?.[1]).toEqual({ channelName: 'First brand' });
    expect(profile.ensureAccountPassword).not.toHaveBeenCalled();
    expect(profile.ensureSharedPassword).not.toHaveBeenCalled();
  });
  it('uses the existing Facebook login without generating or filling a Page password', async () => {
    const planned: Account = { id: 'fb', platform: 'facebook', label: 'Mia', handle: 'mia', status: 'planned', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL };
    render(<CreateAccountWizard resume={[planned]} onSave={vi.fn()} onClose={vi.fn()}/>);
    await waitFor(() => expect(profile.fillSiteForm).toHaveBeenCalledWith('site-embed-4', { pageName: 'Mia' }, expect.objectContaining({ accountId: 'fb', includePassword: false })));
    expect(profile.ensureAccountPassword).not.toHaveBeenCalled();
    expect(screen.getByText('Sign in with your existing Facebook account.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy password' })).not.toBeInTheDocument();
  });
  it('requires another Google account when 100 saved channels are already planned', async () => {
    const existing: Account[] = Array.from({ length: 100 }, (_, i) => ({ id: `y${i}`, platform: 'youtube', label: `Brand ${i}`, handle: `brand${i}`, status: 'active', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL }));
    const user = userEvent.setup();
    render(<CreateAccountWizard initialPlatforms={['youtube']} existing={existing} onSave={vi.fn()} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Account name'), 'New brand');
    expect(screen.getByText(/Choose a different Google account/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start with 1 social/ })).toBeDisabled();
    await user.clear(screen.getByLabelText('Sign-up email'));
    await user.type(screen.getByLabelText('Sign-up email'), 'another@gmail.com');
    expect(screen.getByRole('button', { name: /Start with 1 social/ })).toBeEnabled();
  });
  it('does not infer a shared Instagram login for a planned account with a duplicate email', async () => {
    const planned: Account = { id: 'new', platform: 'instagram', label: 'Mia', handle: 'mia', status: 'planned', notes: '', signupEmail: DEFAULT_SIGNUP_EMAIL };
    const existing: Account[] = [{ ...planned, id: 'old', status: 'active', label: 'Other' }];
    render(<CreateAccountWizard resume={[planned]} existing={existing} onSave={vi.fn()} onClose={vi.fn()}/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('uses another account’s sign-up email');
    expect(profile.embedPlatformPage).not.toHaveBeenCalled();
    expect(profile.ensureSharedPassword).not.toHaveBeenCalled();
  });
  it('never displays or copies another social account password, even when reveal is still in flight', async () => {
    const planned: Account[] = [
      { id: 'p-ig', platform: 'instagram', label: 'Mia', handle: 'mia', status: 'planned', notes: '', signupEmail: 'mia+ig@example.com' },
      { id: 'p-tt', platform: 'tiktok', label: 'Mia', handle: 'mia', status: 'planned', notes: '', signupEmail: 'mia+tt@example.com' },
    ];
    let release!: (value: string) => void;
    vi.mocked(profile.revealAccountPassword).mockImplementation((id) => id === 'p-ig' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('tiktok-password'));
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CreateAccountWizard resume={planned} onSave={vi.fn()} onClose={vi.fn()}/>);
    await waitFor(() => expect(profile.embedPlatformPage).toHaveBeenCalledWith('instagram', 'create', expect.anything()));
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByRole('button', { name: 'Instagram account is created, next' })).toBeDisabled();
    release('instagram-password');
    expect(await screen.findByText('instagram-password')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Instagram account is created, next' }));
    expect(await screen.findByText('Now: TikTok (2 of 2)')).toBeInTheDocument();
    expect(screen.queryByText('instagram-password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy password' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('tiktok-password'));
    expect(writeText).not.toHaveBeenCalledWith('instagram-password');
  });
  it('reports a password-storage failure before opening an account sign-up', async () => {
    vi.mocked(profile.ensureAccountPassword).mockRejectedValue(new Error('Password storage unavailable'));
    const planned: Account = { id: 'p1', platform: 'instagram', label: 'Mia', handle: 'mia', status: 'planned', notes: '', signupEmail: 'mia@example.com' };
    render(<CreateAccountWizard resume={[planned]} onSave={vi.fn()} onClose={vi.fn()}/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Password storage unavailable');
    expect(profile.embedPlatformPage).not.toHaveBeenCalled();
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
