import { invoke, isTauri } from '@tauri-apps/api/core';

export type ImageStyle = 'photo' | 'product' | 'illustration' | 'logo';
export type GeneratedImage = { path: string; preview: string };

export const STYLES: { id: ImageStyle; label: string }[] = [
  { id: 'photo', label: 'Photo portrait' },
  { id: 'product', label: 'Product photo' },
  { id: 'illustration', label: 'Illustrated avatar' },
  { id: 'logo', label: 'Logo mark' },
];
// Portraits describe a made-up person, so results do not imitate anyone real.
const STYLE_PROMPTS: Record<ImageStyle, { before: string; after: string; avoid: string }> = {
  photo: {
    before: 'photorealistic headshot portrait of a fictional person,',
    after: 'natural soft lighting, 85mm lens, shallow depth of field, sharp focus, detailed skin texture, centered, looking at camera, social media profile picture',
    avoid: 'no text, no watermark, a single person',
  },
  product: {
    before: 'professional product photograph,',
    after: 'styled close-up, soft natural light, shallow depth of field, sharp focus, clean uncluttered background, centered, no people, social media profile picture',
    avoid: 'no people, no text, no watermark',
  },
  illustration: {
    before: 'stylized illustrated avatar of a fictional character,',
    after: 'clean digital illustration, vibrant colors, centered, simple background, social media profile picture',
    avoid: 'no text, no watermark, a single character',
  },
  logo: {
    before: 'minimal modern logo mark,',
    after: 'flat vector style, bold simple shapes, centered on a plain background, high contrast, app icon',
    avoid: 'no tiny details, no watermark',
  },
};

export function buildPrompt(description: string, style: ImageStyle, refinements: string[] = []) {
  const parts = STYLE_PROMPTS[style];
  const extra = refinements.map((item) => item.trim()).filter(Boolean);
  return [parts.before, description.trim(), ...extra, parts.after, parts.avoid].filter(Boolean).join(', ').replace(/,\s*,/g, ',');
}

/** The change to ask for when refining a picture Grok already made. */
export function buildRefinePrompt(change: string, style: ImageStyle) {
  return `Keep this ${STYLES.find((item) => item.id === style)?.label.toLowerCase() ?? 'picture'} the same, but ${change.trim()}. ${STYLE_PROMPTS[style].avoid}.`;
}

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to generate pictures.'); }

/** Makes a square picture with Grok Imagine, or changes an earlier generated one (`sourcePath`). */
export async function generateProfileImage(options: { prompt: string; sourcePath?: string }): Promise<GeneratedImage> {
  desktopOnly();
  return invoke('generate_profile_image', { request: { prompt: options.prompt, sourcePath: options.sourcePath ?? null } });
}
