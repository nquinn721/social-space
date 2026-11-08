import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InboxList from './InboxList';
import { isMailFrom } from './CreateAccountWizard';
import * as email from './emailService';

vi.mock('./emailService', () => ({ emailConnection: vi.fn(), listEmails: vi.fn(), readEmail: vi.fn(), openGmailMessage: vi.fn() }));
afterEach(cleanup);

describe('inbox codes during sign-up', () => {
  it('hands over codes only from mail that arrives after the list opens', async () => {
    const old = { uid: 1, from: 'TikTok', subject: '111111 is your code', date: '', unread: true };
    const fresh = { uid: 2, from: 'TikTok <noreply@tiktok.com>', subject: '222222 is your verification code', date: '', unread: true };
    vi.mocked(email.emailConnection).mockResolvedValue({ host: 'imap.gmail.com', username: 'me@gmail.com' });
    vi.mocked(email.listEmails).mockResolvedValueOnce([old]).mockResolvedValue([fresh, old]);
    const onNewCode = vi.fn();
    render(<InboxList compact autoRefresh refreshMs={30} onNewCode={onNewCode}/>);
    expect(await screen.findByText('111111 is your code')).toBeInTheDocument();
    await waitFor(() => expect(onNewCode).toHaveBeenCalledWith('222222', fresh));
    expect(onNewCode).toHaveBeenCalledTimes(1);
  });

  it('matches a code email to the social that sent it', () => {
    expect(isMailFrom('tiktok', { from: 'TikTok <noreply@tiktok.com>', subject: '123456 is your code' })).toBe(true);
    expect(isMailFrom('x', { from: 'X <info@x.com>', subject: 'Your code' })).toBe(true);
    expect(isMailFrom('x', { from: 'Instagram', subject: 'Your box of extras' })).toBe(false);
    expect(isMailFrom('youtube', { from: 'Google <no-reply@accounts.google.com>', subject: 'Verify' })).toBe(true);
  });
});
