import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountsPage, { groupByBrand } from './AccountsPage';
import { migrateWorkspace } from '../brands';
import type { Account, Workspace } from '../model';

vi.mock('../profileService', () => ({ onPasswordSaved: () => () => undefined, hasAccountPassword: vi.fn(async () => false), revealAccountPassword: vi.fn(), setAccountPassword: vi.fn(), exportSignIns: vi.fn(), importSignIns: vi.fn() }));
afterEach(cleanup);
const account = (id: string, platform: Account['platform'], label: string, status: Account['status'] = 'planned'): Account => ({ id, platform, label, handle: 'softwings', status, notes: '', bio: 'Wings.', signupEmail: 'softwings25@gmail.com' });
const accounts = [account('1', 'x', 'Soft Wings'), account('2', 'instagram', 'soft wings ', 'active'), { ...account('3', 'youtube', 'Clip Lab'), handle: 'cliplab' }, { ...account('4', 'instagram', 'Clip Lab'), handle: 'cliplab' }];
const workspace = (list: Account[] = accounts): Workspace => migrateWorkspace({ businessName: '', brands: [], accounts: list, channels: [] });
const renderPage = (props: Partial<Parameters<typeof AccountsPage>[0]> = {}) => render(<AccountsPage workspace={workspace()} loaded busy={false} onAddAccount={vi.fn()} onEditAccount={vi.fn()} onCreateAccounts={vi.fn()} onSignUp={vi.fn()} onOpen={vi.fn()} {...props}/>);
/** Opens a brand on its Accounts tab (a brand opens on its posts). */
async function openBrand(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: `Open ${name}` }));
  await user.click(screen.getByRole('tab', { name: 'Accounts' }));
  return user;
}

describe('brands page', () => {
  it('groups older accounts under one brand by name, in platform order', () => {
    const brands = groupByBrand(workspace());
    expect(brands.map((item) => item.brand.name)).toEqual(['Soft Wings', 'Clip Lab']);
    expect(brands[0].accounts.map((item) => item.platform)).toEqual(['instagram', 'x']);
  });

  it('lists brands first, with how many profiles are live', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Brands' })).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Open Soft Wings' })).getByText('1 of 2 live')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'Open Clip Lab' })).getByText('0 of 2 live')).toBeInTheDocument();
  });

  it('opens a brand to its profiles and creates a missing one in one click', async () => {
    const onSignUp = vi.fn();
    renderPage({ onSignUp });
    const user = await openBrand('Soft Wings');
    const profiles = screen.getByRole('region', { name: 'Soft Wings profiles' });
    expect(within(profiles).getByText('Live')).toBeInTheDocument();
    expect(within(profiles).getByText('Not created yet')).toBeInTheDocument();
    await user.click(within(profiles).getByRole('button', { name: 'Create on X' }));
    expect(onSignUp).toHaveBeenCalledWith([expect.objectContaining({ id: '1' })]);
    expect(within(profiles).queryByRole('button', { name: 'Create on Instagram' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /All brands/ }));
    expect(screen.getByRole('button', { name: 'Open Clip Lab' })).toBeInTheDocument();
  });

  it('creates every not-created profile of a brand at once', async () => {
    const onSignUp = vi.fn();
    renderPage({ onSignUp });
    const user = await openBrand('Clip Lab');
    await user.click(screen.getByRole('button', { name: 'Create all 2 on the socials' }));
    expect(onSignUp.mock.calls[0][0].map((item: Account) => item.id)).toEqual(['4', '3']);
  });

  it('links a profile that was already made on the social', async () => {
    const onAlreadyCreated = vi.fn();
    renderPage({ onAlreadyCreated });
    const user = await openBrand('Soft Wings');
    await user.click(screen.getByRole('button', { name: 'I already made it' }));
    expect(onAlreadyCreated).toHaveBeenCalledWith(expect.objectContaining({ id: '1', platform: 'x' }));
  });

  it('deletes a profile that was never created, and a whole brand', async () => {
    const onRemoveAccount = vi.fn();
    const onRemoveBrand = vi.fn();
    renderPage({ onRemoveAccount, onRemoveBrand });
    const user = await openBrand('Soft Wings');
    expect(screen.queryByRole('button', { name: 'Delete Instagram profile' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete X profile' }));
    expect(onRemoveAccount).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
    await user.click(screen.getByRole('button', { name: 'Delete Soft Wings' }));
    expect(onRemoveBrand).toHaveBeenCalledWith(expect.objectContaining({ name: 'Soft Wings' }));
  });

  it('offers the missing socials pre-filled with the brand details', async () => {
    const onCreateAccounts = vi.fn();
    renderPage({ onCreateAccounts });
    const user = await openBrand('Soft Wings');
    await user.click(within(screen.getByRole('region', { name: 'Soft Wings profiles' })).getByRole('button', { name: 'TikTok' }));
    expect(onCreateAccounts).toHaveBeenCalledWith(['tiktok'], expect.objectContaining({ label: 'Soft Wings', handle: 'softwings', bio: 'Wings.', brandId: expect.any(String) }));
  });

  it('searches brands by name or username', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByRole('searchbox'), 'clipl');
    expect(screen.queryByRole('button', { name: 'Open Soft Wings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Clip Lab' })).toBeInTheDocument();
  });

  it('shows a clear start when there are no brands', () => {
    renderPage({ workspace: workspace([]) });
    expect(screen.getByText('No brands yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New brand' })[0]).toBeEnabled();
  });
  it('opens a brand on its posts, with its accounts on their own tab', async () => {
    const user = userEvent.setup();
    renderPage({ onSave: vi.fn(async () => true) });
    await user.click(screen.getByRole('button', { name: 'Open Soft Wings' }));
    expect(screen.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('navigation', { name: 'Categories' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Soft Wings profiles' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Accounts' }));
    expect(screen.getByRole('region', { name: 'Soft Wings profiles' })).toBeInTheDocument();
  });
  it('renames a brand', async () => {
    const onRenameBrand = vi.fn(async () => true);
    renderPage({ onRenameBrand });
    const user = await openBrand('Soft Wings');
    await user.click(screen.getByRole('button', { name: 'Rename Soft Wings' }));
    const input = screen.getByLabelText('Brand name');
    await user.clear(input);
    await user.type(input, 'Fluffy Bunny{Enter}');
    expect(onRenameBrand).toHaveBeenCalledWith(expect.objectContaining({ name: 'Soft Wings' }), 'Fluffy Bunny');
    expect(screen.queryByLabelText('Brand name')).not.toBeInTheDocument();
  });
});
