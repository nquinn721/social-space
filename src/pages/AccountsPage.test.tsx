import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountsPage, { groupByBrand } from './AccountsPage';
import type { Account, Workspace } from '../model';

afterEach(cleanup);
const account = (id: string, platform: Account['platform'], label: string, status: Account['status'] = 'planned'): Account => ({ id, platform, label, handle: 'softwings', status, notes: '', bio: 'Wings.', signupEmail: 'softwings25@gmail.com' });
const accounts = [account('1', 'x', 'Soft Wings'), account('2', 'instagram', 'soft wings ', 'active'), { ...account('3', 'youtube', 'Clip Lab'), handle: 'cliplab' }, { ...account('4', 'instagram', 'Clip Lab'), handle: 'cliplab' }];
const workspace = (list: Account[] = accounts): Workspace => ({ businessName: '', brands: [], accounts: list, channels: [] });
const renderPage = (props: Partial<Parameters<typeof AccountsPage>[0]> = {}) => render(<AccountsPage workspace={workspace()} loaded busy={false} onAddAccount={vi.fn()} onEditAccount={vi.fn()} onCreateAccounts={vi.fn()} onSignUp={vi.fn()} onOpen={vi.fn()} {...props}/>);

describe('accounts page', () => {
  it('groups older accounts under one brand by name, in platform order', () => {
    const brands = groupByBrand(workspace());
    expect(brands.map((item) => item.brand.name)).toEqual(['Soft Wings', 'Clip Lab']);
    expect(brands[0].accounts.map((item) => item.platform)).toEqual(['instagram', 'x']);
  });

  it('shows which profiles exist on the social and creates a missing one in one click', async () => {
    const onSignUp = vi.fn();
    const user = userEvent.setup();
    renderPage({ onSignUp });
    const brand = screen.getByRole('region', { name: 'Soft Wings' });
    expect(within(brand).getByText('Live')).toBeInTheDocument();
    expect(within(brand).getByText('Not created yet')).toBeInTheDocument();
    await user.click(within(brand).getByRole('button', { name: 'Create on X' }));
    expect(onSignUp).toHaveBeenCalledWith([expect.objectContaining({ id: '1' })]);
    expect(within(brand).queryByRole('button', { name: 'Create on Instagram' })).not.toBeInTheDocument();
  });

  it('creates every not-created profile of a brand at once', async () => {
    const onSignUp = vi.fn();
    const user = userEvent.setup();
    renderPage({ onSignUp });
    await user.click(within(screen.getByRole('region', { name: 'Clip Lab' })).getByRole('button', { name: 'Create all 2 on the socials' }));
    expect(onSignUp.mock.calls[0][0].map((item: Account) => item.id)).toEqual(['4', '3']);
  });

  it('links a profile that was already made on the social', async () => {
    const onAlreadyCreated = vi.fn();
    const user = userEvent.setup();
    renderPage({ onAlreadyCreated });
    await user.click(within(screen.getByRole('region', { name: 'Soft Wings' })).getByRole('button', { name: 'I already made it' }));
    expect(onAlreadyCreated).toHaveBeenCalledWith(expect.objectContaining({ id: '1', platform: 'x' }));
  });

  it('keeps sign-in details off the list', () => {
    renderPage();
    expect(screen.queryByText(/softwings25@gmail.com/)).not.toBeInTheDocument();
  });

  it('offers the missing socials pre-filled with the brand details', async () => {
    const onCreateAccounts = vi.fn();
    const user = userEvent.setup();
    renderPage({ onCreateAccounts });
    const brand = screen.getByRole('region', { name: 'Soft Wings' });
    await user.click(within(brand).getByRole('button', { name: 'TikTok' }));
    expect(onCreateAccounts).toHaveBeenCalledWith(['tiktok'], expect.objectContaining({ label: 'Soft Wings', handle: 'softwings', bio: 'Wings.', brandId: expect.any(String) }));
  });

  it('filters by social and search', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(within(screen.getByRole('group', { name: 'Filter accounts by social' })).getByRole('button', { name: /YouTube/ }));
    expect(screen.queryByRole('region', { name: 'Soft Wings' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Clip Lab' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('group', { name: 'Filter accounts by social' })).getByRole('button', { name: /All/ }));
    await user.type(screen.getByRole('searchbox'), 'soft');
    expect(screen.queryByRole('region', { name: 'Clip Lab' })).not.toBeInTheDocument();
  });

  it('shows a clear start when there are no accounts', () => {
    renderPage({ workspace: workspace([]) });
    expect(screen.getByText('No accounts yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create accounts' })).toBeEnabled();
  });
});
