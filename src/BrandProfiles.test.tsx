import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BrandProfiles, { editorFields } from './BrandProfiles';
import type { Account, Brand } from './model';
import * as posting from './postingService';
import * as writer from './assistant/profileWriter';

vi.mock('./postingService', () => ({ openProfileEditor: vi.fn(async () => 'post-1') }));
vi.mock('./brandImageService', () => ({ pictureFileFor: () => 'abc.jpg', profilePicturePath: vi.fn(async (_file: string, platform: string) => `C:/pics/${platform}.jpg`) }));
vi.mock('./assistant/profileWriter', async (actual) => ({ ...(await actual<typeof import('./assistant/profileWriter')>()), cachedProfileCopy: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const brand: Brand = { id: 'mia', name: 'Massage with Mia', notes: 'Relaxing massage in Austin', image: { file: 'abc.jpg' } };
const account = (platform: Account['platform'], status: Account['status'] = 'active', extra: Partial<Account> = {}): Account =>
  ({ id: platform, platform, label: 'Massage with Mia', handle: 'massagewithmia', status, notes: '', brandId: 'mia', signupEmail: `mia+${platform}@example.com`, ...extra });

describe('brand profile details', () => {
  it('keeps one bio for every social, takes Grok\'s suggestion with Tab, then fills each live profile editor', async () => {
    vi.mocked(writer.cachedProfileCopy).mockResolvedValue({ bios: { instagram: 'Calm hands in Austin, every week.', tiktok: 'Calm hands in Austin', youtube: 'Weekly massage tips.' }, keywords: ['massage', 'relaxation'] });
    const onSave = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<BrandProfiles brand={brand} accounts={[account('instagram'), account('youtube'), account('tiktok', 'planned')]} busy={false} onSave={onSave}/>);
    // One box for every social; TikTok's limit is the tightest, so its suggestion is the one shown.
    const bio = screen.getByLabelText(/Bio on every social/);
    expect(screen.getByText(/TikTok's limit/)).toBeInTheDocument();
    await waitFor(() => expect(bio).toHaveAttribute('placeholder', 'Calm hands in Austin'));
    expect(writer.cachedProfileCopy).toHaveBeenCalledWith('mia', expect.objectContaining({ brand: 'Massage with Mia', platforms: ['instagram', 'youtube', 'tiktok'] }), false);
    bio.focus();
    await user.keyboard('{Tab}');
    expect(bio).toHaveValue('Calm hands in Austin');
    const keywords = screen.getByLabelText(/channel keywords/);
    expect(keywords).toHaveAttribute('placeholder', 'massage, relaxation');
    keywords.focus();
    await user.keyboard('{Tab}');

    await user.click(screen.getByRole('button', { name: /All 2/ }));
    expect(onSave).toHaveBeenCalledWith([
      { id: 'instagram', bio: 'Calm hands in Austin', keywords: [] },
      { id: 'youtube', bio: 'Calm hands in Austin', keywords: ['massage', 'relaxation'] },
      { id: 'tiktok', bio: 'Calm hands in Austin', keywords: [] },
    ], expect.any(String));
    expect(posting.openProfileEditor).toHaveBeenCalledTimes(2);
    expect(posting.openProfileEditor).toHaveBeenCalledWith({ platform: 'instagram', brandId: 'mia', accountId: 'instagram', email: 'mia+instagram@example.com', handle: 'massagewithmia',
      fields: { fullName: 'Massage with Mia', displayName: 'Massage with Mia', bio: 'Calm hands in Austin' }, imagePath: 'C:/pics/instagram.jpg' });
    expect(posting.openProfileEditor).toHaveBeenCalledWith(expect.objectContaining({ platform: 'youtube', fields: expect.objectContaining({ keywords: 'massage, relaxation' }) }));
    expect(await screen.findByRole('status')).toHaveTextContent('press Save there yourself');
  });

  it('shows a box per social when the bios differ, and joins them back into one', async () => {
    const user = userEvent.setup();
    render(<BrandProfiles brand={brand} accounts={[account('instagram', 'active', { bio: 'Long Instagram bio' }), account('tiktok', 'active', { bio: 'Short' })]} busy={false} onSave={vi.fn(async () => true)}/>);
    expect(screen.getByDisplayValue('Long Instagram bio')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Short')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use one bio everywhere' }));
    expect(screen.getByLabelText(/Bio on every social/)).toHaveValue('Short');
  });

  it('does not ask Grok when every profile is written, and never fills a bio over the limit', async () => {
    const user = userEvent.setup();
    render(<BrandProfiles brand={brand} accounts={[account('x', 'active', { bio: 'Done already' })]} busy={false} onSave={vi.fn(async () => true)}/>);
    expect(writer.cachedProfileCopy).not.toHaveBeenCalled();
    const bio = screen.getByDisplayValue('Done already');
    await user.clear(bio);
    await user.type(bio, 'x'.repeat(170));
    expect(screen.getByRole('button', { name: /^X$/ })).toBeDisabled();
  });

  it('fills only the profile fields a social has', () => {
    expect(editorFields(account('tiktok', 'active', { displayName: 'Mia', website: ' https://mia.example ' }), brand, { bio: ' Hi ', keywords: 'spa' }))
      .toEqual({ fullName: 'Mia', displayName: 'Mia', bio: 'Hi', website: 'https://mia.example' });
  });

  it('tells the user to enter X profile details manually', async () => {
    const user = userEvent.setup();
    render(<BrandProfiles brand={brand} accounts={[account('x', 'active', { bio: 'Done' })]} busy={false} onSave={vi.fn(async () => true)}/>);
    await user.click(screen.getByRole('button', { name: /^X$/ }));
    expect(posting.openProfileEditor).toHaveBeenCalledWith(expect.objectContaining({ platform: 'x' }));
    expect(await screen.findByRole('status')).toHaveTextContent('On X, enter the details yourself.');
  });
});
