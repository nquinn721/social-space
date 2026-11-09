import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as service from './service';
import type { Workspace } from './model';

vi.mock('./service', () => ({
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  openPlatformAction: vi.fn(),
  openKling: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(service.saveWorkspace).mockImplementation(async (workspace: Workspace) => workspace);
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

  it('adds an account while preserving the existing workspace', async () => {
    vi.mocked(service.loadWorkspace).mockResolvedValue({ businessName: 'Example LLC', brands: [], accounts: [], channels: [] });
    const user = userEvent.setup();
    render(<App />);

    const add = screen.getByRole('button', { name: 'Add an existing account' });
    await waitFor(() => expect(add).toBeEnabled());
    await user.click(add);
    const dialog = screen.getByRole('dialog', { name: 'Add an account' });
    await user.selectOptions(within(dialog).getByLabelText('Platform'), 'youtube');
    await user.type(within(dialog).getByLabelText('Account name'), 'Example Channel');
    await user.type(within(dialog).getByLabelText('Handle optional'), '@example');
    await user.selectOptions(within(dialog).getByLabelText('Status'), 'active');
    await user.click(within(dialog).getByRole('button', { name: 'Add account' }));

    await waitFor(() => expect(service.saveWorkspace).toHaveBeenCalledOnce());
    expect(service.saveWorkspace).toHaveBeenCalledWith({
      businessName: 'Example LLC',
      brands: [],
      channels: [],
      accounts: [expect.objectContaining({ platform: 'youtube', label: 'Example Channel', handle: 'example', status: 'active', notes: '' })],
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Account added to your workspace.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Brands' }));
    expect(screen.getByRole('button', { name: 'Open Example Channel' })).toHaveTextContent('1 of 1 live');
  });

  it('keeps account and settings saves disabled when loading fails', async () => {
    vi.mocked(service.loadWorkspace).mockRejectedValue(new Error('Unreadable workspace'));
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('status')).toHaveTextContent('Could not load your workspace.');
    expect(screen.getByRole('button', { name: 'Add an existing account' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Brands' }));
    expect(screen.getAllByRole('button', { name: 'Add an existing account' })[0]).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.type(screen.getByLabelText('Business or LLC name'), 'New name');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(service.saveWorkspace).not.toHaveBeenCalled();
  });
});
