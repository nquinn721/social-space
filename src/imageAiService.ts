import { invoke, isTauri } from '@tauri-apps/api/core';

/** Fast uses SDXL (seconds). Detailed uses Qwen-Image (minutes on a laptop GPU, sharper results). */
export type Look = 'fast' | 'detailed';
export type ImageStyle = 'photo' | 'product' | 'illustration' | 'logo';
export type ImageAiStatus = { running: boolean; looks: Look[]; canStart: boolean };
export type GeneratedImage = { path: string; seed: number; preview: string };
export type ImageAiSettings = { baseUrl: string };

export const DEFAULT_IMAGE_AI: ImageAiSettings = { baseUrl: 'http://127.0.0.1:8188' };
const SETTINGS_KEY = 'socialspace-image-ai-settings';
/** How far a refine may move away from the current picture. */
export const REFINE_STRENGTH = { light: 0.35, medium: 0.5, strong: 0.7 } as const;
export type RefineAmount = keyof typeof REFINE_STRENGTH;

export const STYLES: { id: ImageStyle; label: string }[] = [
  { id: 'photo', label: 'Photo portrait' },
  { id: 'product', label: 'Product photo' },
  { id: 'illustration', label: 'Illustrated avatar' },
  { id: 'logo', label: 'Logo mark' },
];
// Portraits describe a made-up person, so results do not imitate anyone real.
const STYLE_PROMPTS: Record<ImageStyle, { before: string; after: string; negative: string }> = {
  photo: {
    before: 'photorealistic headshot portrait of a fictional person,',
    after: 'natural soft lighting, 85mm lens, shallow depth of field, sharp focus, detailed skin texture, centered, looking at camera, social media profile picture',
    negative: 'text, watermark, logo, signature, blurry, lowres, deformed, distorted face, extra fingers, cartoon, painting, cropped head, multiple people',
  },
  product: {
    before: 'professional product photograph,',
    after: 'styled close-up, soft natural light, shallow depth of field, sharp focus, clean uncluttered background, centered, no people, social media profile picture',
    negative: 'people, person, face, hands, text, watermark, logo, signature, blurry, lowres, deformed, cluttered',
  },
  illustration: {
    before: 'stylized illustrated avatar of a fictional character,',
    after: 'clean digital illustration, vibrant colors, centered, simple background, social media profile picture',
    negative: 'text, watermark, signature, blurry, lowres, deformed, photo, multiple people',
  },
  logo: {
    before: 'minimal modern logo mark,',
    after: 'flat vector style, bold simple shapes, centered on a plain background, high contrast, app icon',
    negative: 'photo, realistic, blurry, lowres, watermark, cluttered, tiny details',
  },
};

export function buildPrompt(description: string, style: ImageStyle, refinements: string[] = []) {
  const parts = STYLE_PROMPTS[style];
  const extra = refinements.map((item) => item.trim()).filter(Boolean);
  return { prompt: [parts.before, description.trim(), ...extra, parts.after].filter(Boolean).join(', ').replace(/,\s*,/g, ','), negative: parts.negative };
}

export function loadImageAiSettings(): ImageAiSettings {
  try { return { ...DEFAULT_IMAGE_AI, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') ?? {}) }; } catch { return DEFAULT_IMAGE_AI; }
}

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to generate pictures.'); }

export async function imageAiStatus(settings = loadImageAiSettings()): Promise<ImageAiStatus> {
  desktopOnly();
  return invoke('image_ai_status', { baseUrl: settings.baseUrl });
}
/** Starts the installed ComfyUI in the background and waits until it answers. */
export async function startImageAi(settings = loadImageAiSettings()): Promise<void> {
  desktopOnly();
  return invoke('start_image_ai', { baseUrl: settings.baseUrl });
}
export type GenerateOptions = { prompt: string; negative: string; look: Look; seed?: number; sourcePath?: string; strength?: number };
export async function generateProfileImage(options: GenerateOptions, settings = loadImageAiSettings()): Promise<GeneratedImage> {
  desktopOnly();
  return invoke('generate_profile_image', { request: { baseUrl: settings.baseUrl, prompt: options.prompt, negative: options.negative, look: options.look, seed: options.seed ?? null, sourcePath: options.sourcePath ?? null, strength: options.strength ?? null } });
}
