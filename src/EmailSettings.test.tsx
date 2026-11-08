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
  it('connects through the Gmail sign-in in the app without an app password', async () => {
    vi.mocked(email.connectGmailSession).mockResolvedValue({ host: 'Gmail sign-in in the app', username: 'softwings25@gmail.com', kind: 'gmail' });
    const user = userEvent.setup();
    render(<EmailSettings/>);
    await user.click(await screen.findByRole('button', { name: /Sign in to Gmail/ }));
    expect(email.openGmailSignIn).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /I'm signed in, connect/ }));
    expect(await screen.findByText('softwings25@gmail.com')).toBeInTheDocument();
    expect(screen.getByText(/unread mail/)).toBeInTheDocument();
    expect(email.connectEmail).not.toHaveBeenCalled();
  });

  it('shows why the Gmail connection failed', async () => {
    vi.mocked(email.connectGmailSession).mockRejectedValue('Not signed in to Gmail in the app yet. Use Sign in to Gmail in Settings.');
    const user = userEvent.setup();
    render(<EmailSettings/>);
    await user.click(await screen.findByRole('button', { name: /Use my Gmail sign-in/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not signed in to Gmail');
  });

  it('keeps the app password option', async () => {
    const user = userEvent.setup();
    render(<EmailSettings/>);
    await user.click(await screen.findByText(/Use an app password instead/));
    expect(screen.getByLabelText('App password')).toBeInTheDocument();
  });
});
