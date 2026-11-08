import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountsPage, { groupByBrand } from './AccountsPage';
import type { Account } from '../model';

afterEach(cleanup);
const account = (id: string, platform: Account['platform'], label: string, status: Account['status'] = 'planned'): Account => ({ id, platform, label, handle: 'softwings', status, notes: '', bio: 'Wings.' });
const accounts = [account('1', 'x', 'Soft Wings'), account('2', 'instagram', 'soft wings ', 'active'), { ...account('3', 'youtube', 'Clip Lab'), handle: 'cliplab' }];

describe('accounts page', () => {
  it('groups accounts made together under one brand, in platform order', () => {
    const brands = groupByBrand(accounts);
    expect(brands).toHaveLength(2);
    expect(brands[0].accounts.map((item) => item.platform)).toEqual(['instagram', 'x']);
  });

  it('offers the missing socials pre-filled with the brand details', async () => {
    const onCreateAccounts = vi.fn();
    const user = userEvent.setup();
    render(<AccountsPage workspace={{ businessName: '', accounts, channels: [] }} loaded busy={false} onAddAccount={vi.fn()} onEditAccount={vi.fn()} onCreateAccounts={onCreateAccounts} onOpen={vi.fn()}/>);
    const brand = screen.getByRole('region', { name: 'Soft Wings' });
    await user.click(within(brand).getByRole('button', { name: 'TikTok' }));
    expect(onCreateAccounts).toHaveBeenCalledWith(['tiktok'], expect.objectContaining({ handle: 'softwings', bio: 'Wings.' }));
  });

  it('filters by social and search', async () => {
    const user = userEvent.setup();
    render(<AccountsPage workspace={{ businessName: '', accounts, channels: [] }} loaded busy={false} onAddAccount={vi.fn()} onEditAccount={vi.fn()} onCreateAccounts={vi.fn()} onOpen={vi.fn()}/>);
    await user.click(within(screen.getByRole('group', { name: 'Filter accounts by social' })).getByRole('button', { name: /YouTube/ }));
    expect(screen.queryByRole('region', { name: 'Soft Wings' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Clip Lab' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('group', { name: 'Filter accounts by social' })).getByRole('button', { name: /All/ }));
    await user.type(screen.getByRole('searchbox'), 'soft');
    expect(screen.queryByRole('region', { name: 'Clip Lab' })).not.toBeInTheDocument();
  });

  it('shows a clear start when there are no accounts', () => {
    render(<AccountsPage workspace={{ businessName: '', accounts: [], channels: [] }} loaded busy={false} onAddAccount={vi.fn()} onEditAccount={vi.fn()} onCreateAccounts={vi.fn()} onOpen={vi.fn()}/>);
    expect(screen.getByText('No accounts yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create accounts' })).toBeEnabled();
  });
});
