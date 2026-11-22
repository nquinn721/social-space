import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrandPicture from './BrandPicture';
import ProfileImageStudio from './ProfileImageStudio';
import * as pictures from './brandImageService';
import * as posting from './brandWindowService';
import * as images from './imageAiService';
import type { Account, Brand } from './model';

vi.mock('./brandImageService', async (original) => ({ ...(await original<typeof import('./brandImageService')>()),
  generatePictures: vi.fn(), keepSquare: vi.fn(), keepBanner: vi.fn(), keepFile: vi.fn(), profilePicturePath: vi.fn(), brandImagePreview: vi.fn(), revealBrandImage: vi.fn() }));
vi.mock('./imageAiService', async (original) => ({ ...(await original<typeof import('./imageAiService')>()), generateProfileImage: vi.fn() }));
vi.mock('./profileService', async (original) => ({ ...(await original<typeof import('./profileService')>()), chooseImageFile: vi.fn() }));
vi.mock('./brandWindowService', async (original) => ({ ...(await original<typeof import('./brandWindowService')>()), openProfileEditor: vi.fn() }));

const brand: Brand = { id: 'b1', name: 'Bunnies', notes: '' };
const account = (platform: Account['platform'], extra: Partial<Account> = {}): Account => ({ id: `a-${platform}`, platform, label: 'Bunnies', handle: 'bunnies', status: 'active', notes: '', brandId: 'b1', signupEmail: 'me@example.com', ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  let made = 0;
  vi.mocked(pictures.generatePictures).mockImplementation(async ({ count = 1 }) => Array.from({ length: count }, () => { made += 1; return { path: `C:\\pics\\grok-${made}.png`, preview: `data:image/png;base64,${made}` }; }));
  vi.mocked(pictures.keepSquare).mockImplementation(async (preview) => `square-of-${preview.slice(-1)}.jpg`);
  vi.mocked(pictures.keepBanner).mockResolvedValue('banner.jpg');
  vi.mocked(pictures.brandImagePreview).mockImplementation(async (file) => `data:image/jpeg;base64,${file}`);
  vi.mocked(pictures.profilePicturePath).mockImplementation(async (file, platform) => `C:\\sized\\${platform}-${file}`);
  vi.mocked(posting.openProfileEditor).mockResolvedValue('window-1');
});
afterEach(cleanup);

describe('brand picture', () => {
  it('makes four takes with Grok and keeps the chosen one as the brand picture', async () => {
    const onSaveImage = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<BrandPicture brand={brand} accounts={[account('instagram')]} busy={false} onSaveImage={onSaveImage} onSaveAccountImage={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /Generate with Grok/ }));
    await user.click(await screen.findByRole('button', { name: /Make 4 takes/ }));
    expect(await screen.findAllByRole('button', { name: /^Take \d$/ })).toHaveLength(4);
    expect(vi.mocked(pictures.generatePictures).mock.calls[0][0]).toMatchObject({ count: 4, aspect: '1:1' });
    expect(vi.mocked(pictures.generatePictures).mock.calls[0][0].prompt).toContain('Bunnies');
    await user.click(screen.getByRole('button', { name: 'Take 2' }));
    await user.click(screen.getByRole('button', { name: /Use this picture/ }));
    await waitFor(() => expect(onSaveImage).toHaveBeenCalled());
    expect(pictures.keepSquare).toHaveBeenCalledWith('data:image/png;base64,3');
    expect(onSaveImage.mock.calls[0][0]).toMatchObject({ file: 'square-of-3.jpg' });
  });

  it('puts the picture on a live profile at that social\'s size, and lets one social have its own', async () => {
    const onSaveAccountImage = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    const withImage = { ...brand, image: { file: 'brand.jpg' } };
    render(<BrandPicture brand={withImage} accounts={[account('x'), account('youtube', { status: 'planned', imageFile: 'own.jpg' })]} busy={false} onSaveImage={vi.fn()} onSaveAccountImage={onSaveAccountImage}/>);
    expect(screen.getByText(/Used when it's created/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Put on X/ }));
    await waitFor(() => expect(posting.openProfileEditor).toHaveBeenCalled());
    expect(pictures.profilePicturePath).toHaveBeenCalledWith('brand.jpg', 'x');
    expect(vi.mocked(posting.openProfileEditor).mock.calls[0][0]).toMatchObject({ platform: 'x', brandId: 'b1', imagePath: 'C:\\sized\\x-brand.jpg', accountId: 'a-x', fields: {} });
    expect(await screen.findByRole('status')).toHaveTextContent('Choose your picture and save it on X yourself');

    await user.click(screen.getByRole('button', { name: /Use brand picture/ }));
    await waitFor(() => expect(onSaveAccountImage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-youtube' }), undefined, expect.any(String)));
  });

  it('makes a 16:9 YouTube banner', async () => {
    const onSaveImage = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<BrandPicture brand={{ ...brand, image: { file: 'brand.jpg', prompt: 'bunny face' } }} accounts={[account('youtube')]} busy={false} onSaveImage={onSaveImage} onSaveAccountImage={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /Make a banner/ }));
    await user.click(await screen.findByRole('button', { name: /Make 4 takes/ }));
    expect(vi.mocked(pictures.generatePictures).mock.calls[0][0]).toMatchObject({ aspect: '16:9' });
    await user.click(await screen.findByRole('button', { name: /Use this banner/ }));
    await waitFor(() => expect(onSaveImage).toHaveBeenCalledWith({ file: 'brand.jpg', prompt: 'bunny face', banner: 'banner.jpg' }, expect.any(String)));
  });

  it('turns the New brand sign-up picture into the brand picture', async () => {
    vi.mocked(pictures.keepFile).mockResolvedValue('adopted.jpg');
    const onSaveImage = vi.fn().mockResolvedValue(true);
    render(<BrandPicture brand={brand} accounts={[account('tiktok', { imagePath: 'C:\\pics\\profile-1.jpg' })]} busy={false} onSaveImage={onSaveImage} onSaveAccountImage={vi.fn()}/>);
    await waitFor(() => expect(onSaveImage).toHaveBeenCalledWith({ file: 'adopted.jpg' }, expect.any(String)));
    expect(pictures.keepFile).toHaveBeenCalledWith('C:\\pics\\profile-1.jpg');
  });

  it('points to Video sources when there is no xAI key yet', async () => {
    vi.mocked(pictures.generatePictures).mockRejectedValue(new Error('Add your xAI key under Settings > Video sources (Grok Imagine). The assistant and picture maker use the same key.'));
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<BrandPicture brand={brand} accounts={[]} busy={false} onSaveImage={vi.fn()} onSaveAccountImage={vi.fn()} onNavigate={onNavigate}/>);
    await user.click(screen.getByRole('button', { name: /Generate with Grok/ }));
    await user.click(await screen.findByRole('button', { name: /Make 4 takes/ }));
    await user.click(await screen.findByRole('button', { name: 'Open Video sources' }));
    expect(onNavigate).toHaveBeenCalledWith('settings', 'video-sources');
  });
});

describe('profile picture maker', () => {
  it('makes pictures with Grok only', async () => {
    vi.mocked(images.generateProfileImage).mockResolvedValue({ path: 'C:\\pics\\profile-1.png', preview: 'data:image/png;base64,1' });
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(<ProfileImageStudio onUse={onUse} onClose={vi.fn()}/>);
    expect(screen.getByText(/Generate with Grok/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Describe the picture'), 'bunny');
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    await user.click(await screen.findByRole('button', { name: /Use this picture/ }));
    expect(onUse).toHaveBeenCalledWith('C:\\pics\\profile-1.png');
    expect(pictures.generatePictures).not.toHaveBeenCalled();
  });
});

describe('picture sizes', () => {
  it('uses a profile\'s own picture before the brand\'s and sizes per social', () => {
    expect(pictures.pictureFileFor({ imageFile: 'own.jpg' }, { image: { file: 'brand.jpg' } })).toBe('own.jpg');
    expect(pictures.pictureFileFor({}, { image: { file: 'brand.jpg' } })).toBe('brand.jpg');
    expect(pictures.pictureFileFor({}, undefined)).toBeUndefined();
    expect(pictures.PROFILE_SIZES).toEqual({ instagram: 1024, tiktok: 720, youtube: 800, x: 400, facebook: 720 });
    expect(pictures.dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(pictures.bannerPrompt('Bunnies', '')).toMatch(/No text/);
  });
});
