import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstagramAppSetup from './InstagramAppSetup';
import { openPlatformAction } from './service';

vi.mock('./service', () => ({ openPlatformAction: vi.fn() }));
vi.mock('./instagramService', () => ({ INSTAGRAM_REDIRECT_URI: 'https://localhost/socialspace/instagram' }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(openPlatformAction).mockResolvedValue(undefined); });
afterEach(cleanup);

describe('Instagram one-time setup', () => {
  it('explains every step and opens Meta for Developers', async () => {
    const user = userEvent.setup();
    render(<InstagramAppSetup working={false} onSave={vi.fn()} onCancel={vi.fn()}/>);
    expect(screen.getByText(/Make the Instagram account professional/)).toBeInTheDocument();
    expect(screen.getByText('https://localhost/socialspace/instagram')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Open Meta for Developers/ }));
    expect(openPlatformAction).toHaveBeenCalledWith('instagram', 'developer');
  });

  it('copies the sign-in address', async () => {
    const user = userEvent.setup();
    render(<InstagramAppSetup working={false} onSave={vi.fn()} onCancel={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /Copy/ }));
    expect(await navigator.clipboard.readText()).toBe('https://localhost/socialspace/instagram');
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  it('saves trimmed values and clears the secret', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<InstagramAppSetup working={false} onSave={onSave} onCancel={vi.fn()}/>);
    expect(screen.getByRole('button', { name: 'Save and connect' })).toBeDisabled();
    await user.type(screen.getByLabelText('Instagram App ID'), ' 123 ');
    await user.type(screen.getByLabelText('Instagram App Secret'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(onSave).toHaveBeenCalledWith('123', 'secret');
    expect(await screen.findByLabelText('Instagram App Secret')).toHaveValue('');
  });
});
