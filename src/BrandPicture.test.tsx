import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrandPicture from './BrandPicture';
import ProfileImageStudio from './ProfileImageStudio';
import * as pictures from './brandImageService';
import * as profile from './profileService';
import type { Account, Brand } from './model';

vi.mock('./brandImageService', async (original) => ({ ...(await original<typeof import('./brandImageService')>()),
  geminiKeyStatus: vi.fn(), generateGeminiImages: vi.fn(), keepSquare: vi.fn(), keepBanner: vi.fn(), keepFile: vi.fn(), profilePicturePath: vi.fn(), brandImagePreview: vi.fn(), revealBrandImage: vi.fn() }));
vi.mock('./profileService', async (original) => ({ ...(await original<typeof import('./profileService')>()), openPlatformWindow: vi.fn(), fillSiteForm: vi.fn(), chooseImageFile: vi.fn() }));

const brand: Brand = { id: 'b1', name: 'Bunnies', notes: '' };
const account = (platform: Account['platform'], extra: Partial<Account> = {}): Account => ({ id: `a-${platform}`, platform, label: 'Bunnies', handle: 'bunnies', status: 'active', notes: '', brandId: 'b1', signupEmail: 'me@example.com', ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  let made = 0;
  vi.mocked(pictures.geminiKeyStatus).mockResolvedValue(true);
  vi.mocked(pictures.generateGeminiImages).mockImplementation(async ({ count = 1 }) => Array.from({ length: count }, () => { made += 1; return { path: `C:\\pics\\gemini-${made}.png`, preview: `data:image/png;base64,${made}` }; }));
  vi.mocked(pictures.keepSquare).mockImplementation(async (preview) => `square-of-${preview.slice(-1)}.jpg`);
  vi.mocked(pictures.keepBanner).mockResolvedValue('banner.jpg');
  vi.mocked(pictures.brandImagePreview).mockImplementation(async (file) => `data:image/jpeg;base64,${file}`);
  vi.mocked(pictures.profilePicturePath).mockImplementation(async (file, platform) => `C:\\sized\\${platform}-${file}`);
  vi.mocked(profile.openPlatformWindow).mockResolvedValue('window-1');
});
afterEach(cleanup);

describe('brand picture', () => {
  it('makes four takes with Gemini and keeps the chosen one as the brand picture', async () => {
    const onSaveImage = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<BrandPicture brand={brand} accounts={[account('instagram')]} busy={false} onSaveImage={onSaveImage} onSaveAccountImage={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /Generate with Gemini/ }));
    await user.click(await screen.findByRole('button', { name: /Make 4 takes/ }));
    expect(await screen.findAllByRole('button', { name: /^Take \d$/ })).toHaveLength(4);
    expect(vi.mocked(pictures.generateGeminiImages).mock.calls[0][0]).toMatchObject({ count: 4, aspect: '1:1' });
    expect(vi.mocked(pictures.generateGeminiImages).mock.calls[0][0].prompt).toContain('Bunnies');
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
    await waitFor(() => expect(profile.fillSiteForm).toHaveBeenCalled());
    expect(pictures.profilePicturePath).toHaveBeenCalledWith('brand.jpg', 'x');
    expect(vi.mocked(profile.fillSiteForm).mock.calls[0][2]).toMatchObject({ imagePath: 'C:\\sized\\x-brand.jpg', accountId: 'a-x' });
    expect(await screen.findByRole('status')).toHaveTextContent('press Save on the page');

    await user.click(screen.getByRole('button', { name: /Use brand picture/ }));
    await waitFor(() => expect(onSaveAccountImage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-youtube' }), undefined, expect.any(String)));
  });

  it('makes a 16:9 YouTube banner', async () => {
    const onSaveImage = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<BrandPicture brand={{ ...brand, image: { file: 'brand.jpg', prompt: 'bunny face' } }} accounts={[]} busy={false} onSaveImage={onSaveImage} onSaveAccountImage={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /Make a banner/ }));
    await user.click(await screen.findByRole('button', { name: /Make 4 takes/ }));
    expect(vi.mocked(pictures.generateGeminiImages).mock.calls[0][0]).toMatchObject({ aspect: '16:9' });
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

  it('asks for the Gemini key when none is saved', async () => {
    vi.mocked(pictures.geminiKeyStatus).mockResolvedValue(false);
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(<BrandPicture brand={brand} accounts={[]} busy={false} onSaveImage={vi.fn()} onSaveAccountImage={vi.fn()} onNavigate={onNavigate}/>);
    await user.click(screen.getByRole('button', { name: /Generate with Gemini/ }));
    await user.click(await screen.findByRole('button', { name: 'Open Settings' }));
    expect(onNavigate).toHaveBeenCalledWith('settings', 'pictures');
    expect(screen.getByRole('button', { name: /Make 4 takes/ })).toBeDisabled();
  });
});

describe('profile picture maker with a Gemini key', () => {
  it('makes four takes with Gemini to pick from', async () => {
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(<ProfileImageStudio onUse={onUse} onClose={vi.fn()}/>);
    expect(await screen.findByText(/Generate with Gemini/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Describe the picture'), 'bunny');
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    expect(await screen.findAllByRole('button', { name: /^Picture \d$/ })).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'Picture 1' }));
    await user.click(screen.getByRole('button', { name: /Use this picture/ }));
    expect(onUse).toHaveBeenCalledWith('C:\\pics\\gemini-4.png');
  });
});

describe('picture sizes', () => {
  it('uses a profile\'s own picture before the brand\'s and sizes per social', () => {
    expect(pictures.pictureFileFor({ imageFile: 'own.jpg' }, { image: { file: 'brand.jpg' } })).toBe('own.jpg');
    expect(pictures.pictureFileFor({}, { image: { file: 'brand.jpg' } })).toBe('brand.jpg');
    expect(pictures.pictureFileFor({}, undefined)).toBeUndefined();
    expect(pictures.PROFILE_SIZES).toEqual({ instagram: 1024, tiktok: 720, youtube: 800, x: 400 });
    expect(pictures.dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(pictures.bannerPrompt('Bunnies', '')).toMatch(/No text/);
  });
});
