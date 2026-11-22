import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as service from './service';
import * as updateService from './updateService';
import type { Workspace } from './model';

vi.mock('./service', () => ({
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  openPlatformAction: vi.fn(),
  openKling: vi.fn(),
}));

vi.mock('./updateService', async (original) => ({ ...(await original<typeof import('./updateService')>()), updateManagement: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(service.saveWorkspace).mockImplementation(async (workspace: Workspace) => workspace);
  vi.mocked(updateService.updateManagement).mockResolvedValue({ managedBy: null });
});
afterEach(cleanup);

describe('workspace account management', () => {
  it('always has an Updates page in the sidebar', async () => {
    vi.mocked(service.loadWorkspace).mockResolvedValue({ businessName: '', brands: [], accounts: [], channels: [] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Updates' }));
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart without updating' })).toBeInTheDocument();
  });

  it('hides its Updates page while Ava manages updates and says so in Settings', async () => {
    vi.mocked(updateService.updateManagement).mockResolvedValue({ managedBy: 'Ava' });
    vi.mocked(service.loadWorkspace).mockResolvedValue({ businessName: '', brands: [], accounts: [], channels: [] });
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Updates' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Updates managed by Ava.')).toBeInTheDocument();
  });

  it('has the six pages in the sidebar and saves Settings without losing the workspace', async () => {
    const brands = [{ id: 'b1', name: 'Bunny', notes: '' }];
    vi.mocked(service.loadWorkspace).mockResolvedValue({ businessName: 'Example LLC', brands, accounts: [], channels: [] });
    const user = userEvent.setup();
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getAllByRole('button').map((item) => item.getAttribute('aria-label'))).toEqual(['Today', 'Brands', 'Calendar', 'Results', 'Comments']);
    expect(screen.queryByRole('button', { name: 'Inbox' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add an existing account' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const name = screen.getByLabelText('Business or LLC name');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    await user.clear(name);
    await user.type(name, 'Bunny LLC');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(service.saveWorkspace).toHaveBeenCalledOnce());
    expect(service.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'Bunny LLC', brands }));
    await user.click(screen.getByRole('button', { name: 'Brands' }));
    expect(screen.getByRole('button', { name: 'Open Bunny' })).toHaveTextContent('No socials linked yet');
  });

  it('keeps account and settings saves disabled when loading fails', async () => {
    vi.mocked(service.loadWorkspace).mockRejectedValue(new Error('Unreadable workspace'));
    const user = userEvent.setup();
    render(<App />);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Could not load your workspace.');
    expect(banner).toHaveClass('notice-error');
    expect(screen.getByRole('button', { name: 'New brand' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Brands' }));
    expect(screen.getAllByRole('button', { name: 'New brand' })[0]).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.type(screen.getByLabelText('Business or LLC name'), 'New name');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(service.saveWorkspace).not.toHaveBeenCalled();
  });
});
