import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Account, Brand, Platform } from './model';
import { loadImagePreview } from './profileService';

/** A picture Gemini made, saved on this PC, with a data URL to show it. */
export type GeneratedImage = { path: string; preview: string };
export type Aspect = '1:1' | '16:9';

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use pictures.'); }

export const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';
export async function geminiKeyStatus(): Promise<boolean> { if (!isTauri()) return false; return invoke('gemini_key_status'); }
/** Checks the key with Google, then keeps it in Windows Credential Manager (shared with the partner's app). */
export async function saveGeminiKey(key: string): Promise<void> { desktopOnly(); return invoke('save_gemini_key', { key }); }
export async function removeGeminiKey(): Promise<void> { desktopOnly(); return invoke('remove_gemini_key'); }

/** Makes `count` takes (1 to 4) with Gemini, or changes an earlier generated picture (`sourcePath`). */
export async function generateGeminiImages(options: { prompt: string; count?: number; aspect?: Aspect; sourcePath?: string }): Promise<GeneratedImage[]> {
  desktopOnly();
  return invoke('generate_gemini_images', { request: { prompt: options.prompt, count: options.count ?? 1, aspect: options.aspect ?? '1:1', sourcePath: options.sourcePath ?? null } });
}

/** Saves a prepared JPG with the brand pictures and returns its file name (what the workspace stores). */
export async function saveBrandImage(dataUrl: string): Promise<{ file: string; path: string }> { desktopOnly(); return invoke('save_brand_image', { dataUrl }); }
export async function brandImagePath(file: string): Promise<string> { desktopOnly(); return invoke('brand_image_path', { file }); }
export async function revealBrandImage(file: string): Promise<void> { desktopOnly(); return invoke('reveal_brand_image', { file }); }

// ---- Sizes ------------------------------------------------------------------------------------------------

/** The kept copy of a brand picture: big enough for every social, small enough to sync. */
export const MASTER_SIZE = 1024;
/** YouTube's minimum banner size; its safe area (shown on every device) is the centre 1235 x 338. */
export const BANNER = { width: 2048, height: 1152, safeWidth: 1235, safeHeight: 338 };
export const MAX_SHARED_BYTES = 550 * 1024;
/** Square upload size per social: each shows it as a circle, at most at these sizes. */
export const PROFILE_SIZES: Record<Platform, number> = { instagram: 1024, tiktok: 720, youtube: 800, x: 400 };

/** The picture a profile uses: its own when it has one, otherwise the brand's. */
export function pictureFileFor(account: Pick<Account, 'imageFile'>, brand?: Pick<Brand, 'image'>): string | undefined {
  return account.imageFile || brand?.image?.file || undefined;
}

export function dataUrlBytes(dataUrl: string) {
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

/** The prompt for a banner that matches the brand picture. */
export function bannerPrompt(brandName: string, idea: string) {
  const about = idea.trim() || brandName;
  return `Wide YouTube channel banner for "${brandName}": ${about}. Matching style and colors to the channel's profile picture. Keep the main subject in a thin horizontal band across the middle, with calm background that extends to the edges. No text, no letters, no watermark, no logos of other brands.`;
}

// ---- Canvas -----------------------------------------------------------------------------------------------

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That picture could not be read.'));
    image.src = src;
  });
}

/** Scales and centre-crops a picture to width x height, then saves it as a JPG under maxBytes. */
export async function renderJpeg(src: string, width: number, height: number, maxBytes = MAX_SHARED_BYTES): Promise<string> {
  const image = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Pictures cannot be prepared on this PC.');
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawn = { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (width - drawn.width) / 2, (height - drawn.height) / 2, drawn.width, drawn.height);
  for (const quality of [0.92, 0.86, 0.8, 0.72, 0.64, 0.55]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (dataUrlBytes(url) <= maxBytes) return url;
  }
  throw new Error('That picture is too detailed to share. Try another take.');
}

/** Keeps a picture (a data URL or a file preview) as the brand's square picture; returns its file name. */
export async function keepSquare(src: string) { return (await saveBrandImage(await renderJpeg(src, MASTER_SIZE, MASTER_SIZE))).file; }
export async function keepBanner(src: string) { return (await saveBrandImage(await renderJpeg(src, BANNER.width, BANNER.height))).file; }

/** A local file someone chose (e.g. from the wizard), kept as a brand picture. */
export async function keepFile(path: string) { return keepSquare(await loadImagePreview(path)); }

const sized = new Map<string, string>();
/** The picture at this social's upload size, as a file on this PC to fill into its profile page. */
export async function profilePicturePath(file: string, platform: Platform): Promise<string> {
  const key = `${file}|${platform}`;
  const known = sized.get(key);
  if (known) return known;
  const preview = await loadImagePreview(await brandImagePath(file));
  const size = PROFILE_SIZES[platform];
  const { path } = await saveBrandImage(await renderJpeg(preview, size, size));
  sized.set(key, path);
  return path;
}

/** Shows a stored brand picture: its preview data URL, or '' while it hasn't arrived on this PC. */
export async function brandImagePreview(file: string): Promise<string> {
  return loadImagePreview(await brandImagePath(file));
}
