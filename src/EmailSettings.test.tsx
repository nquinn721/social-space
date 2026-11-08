import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailSettings from './EmailSettings';
import * as email from './emailService';

vi.mock('./emailService', () => ({ emailConnection: vi.fn(), connectEmail: vi.fn(), disconnectEmail: vi.fn(), openGmailSignIn: vi.fn(), connectGmailSession: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(email.emailConnection).mockResolvedValue(null); });
afterEach(cleanup);

describe('email settings', () => {
  it('opens the Gmail sign-in and connects by itself once signed in', async () => {
    vi.mocked(email.connectGmailSession)
      .mockRejectedValueOnce('Not signed in to Gmail yet.')
      .mockResolvedValue({ host: 'Gmail sign-in in the app', username: 'softwings25@gmail.com', kind: 'gmail' });
    const user = userEvent.setup();
    render(<EmailSettings/>);
    await user.click(await screen.findByRole('button', { name: /Sign in to Gmail/ }));
    expect(email.openGmailSignIn).toHaveBeenCalled();
    expect(screen.getByText(/connects by itself/)).toBeInTheDocument();
    expect(await screen.findByText('softwings25@gmail.com', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText(/unread mail/)).toBeInTheDocument();
    expect(email.connectEmail).not.toHaveBeenCalled();
  }, 10_000);

  it('connects straight away when Gmail is already signed in', async () => {
    vi.mocked(email.connectGmailSession).mockResolvedValue({ host: 'Gmail sign-in in the app', username: 'softwings25@gmail.com', kind: 'gmail' });
    const user = userEvent.setup();
    render(<EmailSettings/>);
    await user.click(await screen.findByRole('button', { name: /Sign in to Gmail/ }));
    expect(await screen.findByText('softwings25@gmail.com')).toBeInTheDocument();
    expect(email.openGmailSignIn).not.toHaveBeenCalled();
  });

  it('says why when the check finds no sign-in', async () => {
    vi.mocked(email.connectGmailSession).mockRejectedValue('Not signed in to Gmail yet.');
    const user = userEvent.setup();
    render(<EmailSettings/>);
    await user.click(await screen.findByRole('button', { name: /Sign in to Gmail/ }));
    await user.click(screen.getByRole('button', { name: /I'm signed in/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not signed in to Gmail');
  });

  it('keeps the app password option', async () => {
    const user = userEvent.setup();
    render(<EmailSettings/>);
    await user.click(await screen.findByText(/Use an app password instead/));
    expect(screen.getByLabelText('App password')).toBeInTheDocument();
  });
});
