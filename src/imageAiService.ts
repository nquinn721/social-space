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

/** What a picture is for: the brand or account it goes on. Every field is optional. */
export type BrandContext = { name?: string; displayName?: string; handle?: string; bio?: string; notes?: string; idea?: string; topics?: string[] };

const clean = (value?: string) => (value ?? '').replace(/\s+/g, ' ').trim();
function contextWords(context: BrandContext) {
  return [context.name, context.displayName, context.handle, context.bio, context.notes, context.idea, ...(context.topics ?? [])].map(clean).filter(Boolean).join(' ');
}
const PERSON_WORDS = /\b(i'?m|i am|my name|coach|coaching|creator|influencer|vlogs?|vlogger|personal brand|chef|trainer|therapist|masseuse|massage therapist|stylist|makeup artist|model|founder|mom|dad|mama|papa|grandma|grandpa|her|his|she|he|selfies?|face of)\b/i;
const KIDS_WORDS = /\b(kids?|children|child|toddlers?|preschool(ers)?|baby|babies|bedtime|nursery|ages? \d|\d\s?-\s?\d ?(yo|years?))\b/i;
const ILLUSTRATION_WORDS = /\b(illustrat\w*|cartoons?|drawn|drawings?|doodles?|comics?|anime|stor(y|ies)|quotes?|affirmations?|fairy ?tales?|picture books?|animated)\b/i;
const PRODUCT_WORDS = /\b(shop|store|handmade|jewel\w*|candles?|skincare|soap|bak\w*|recipes?|food|coffee|tea|cakes?|cookies?|crafts?|products?|merch|boutique|decor|plants?)\b/i;
const ANIMAL_WORDS = /\b(bunn(y|ies)|rabbits?|cats?|kittens?|dogs?|pupp(y|ies)|goats?|pets?|animals?|birds?|horses?|ponies|pony|hamsters?|foxe?s?|ducks?|chickens?|farm)\b/i;

/** Whether the account is about a person, so a human face fits. "Massage with Mia" is; "Bunny Whispers" is not. */
export function isAboutPerson(context: BrandContext) {
  const text = contextWords(context);
  return PERSON_WORDS.test(text) || /\bwith [A-Z][a-z]+\b/.test(text);
}

/** The picture style that suits the account, so the first take already fits it. */
export function suggestStyle(context: BrandContext): ImageStyle {
  const text = contextWords(context);
  if (!text) return 'photo';
  if (ILLUSTRATION_WORDS.test(text) || KIDS_WORDS.test(text)) return 'illustration';
  if (isAboutPerson(context)) return 'photo';
  if (ANIMAL_WORDS.test(text)) return 'photo';
  if (PRODUCT_WORDS.test(text)) return 'product';
  return 'logo';
}

/** A starting picture description for the account: its idea, else its bio, else its name. */
export function pictureIdeaFor(context: BrandContext) {
  return clean(context.idea) || clean(context.bio) || clean(context.notes) || clean(context.displayName) || clean(context.name);
}

/** The account the picture is for, said in a way the image model uses. */
export function describeBrand(context: BrandContext) {
  const name = clean(context.displayName) || clean(context.name);
  const handle = clean(context.handle).replace(/^@+/, '');
  const about = [clean(context.bio), clean(context.notes), clean(context.idea)].filter(Boolean).filter((item, index, list) => list.indexOf(item) === index).join('. ');
  const topics = (context.topics ?? []).map(clean).filter(Boolean);
  const label = [name ? `"${name}"` : '', handle ? `(@${handle})` : ''].filter(Boolean).join(' ');
  const parts = [label ? `profile picture for the social media account ${label}` : '', about ? `the account is about: ${about}` : '', topics.length ? `its topics: ${topics.join(', ')}` : ''];
  return parts.filter(Boolean).join('; ');
}

const PHOTO_SUBJECT = {
  before: 'photorealistic portrait photo of',
  after: 'natural soft lighting, shallow depth of field, sharp focus, centered, the subject fills the frame, social media profile picture',
};

/**
 * The full Grok prompt. With a brand context, the picture is built around that account:
 * its name, bio and topics, child-friendly for a kids' account, and no human faces unless it is about a person.
 */
export function buildPrompt(description: string, style: ImageStyle, refinements: string[] = [], context?: BrandContext) {
  const person = context ? isAboutPerson(context) : true;
  const parts = style === 'photo' && !person ? { ...STYLE_PROMPTS.photo, ...PHOTO_SUBJECT, avoid: 'no text, no watermark, a single subject' } : STYLE_PROMPTS[style];
  const extra = refinements.map((item) => item.trim()).filter(Boolean);
  const brand = context ? describeBrand(context) : '';
  const kids = context && KIDS_WORDS.test(contextWords(context)) ? 'gentle, friendly and child-safe, soft cheerful colors' : '';
  const noPeople = context && !person ? 'no people, no humans, no human faces' : '';
  return [parts.before, description.trim(), ...extra, brand, kids, parts.after, parts.avoid, noPeople].filter(Boolean).join(', ').replace(/,\s*,/g, ',');
}

/** The change to ask for when refining a picture Grok already made. */
export function buildRefinePrompt(change: string, style: ImageStyle, context?: BrandContext) {
  const noPeople = context && !isAboutPerson(context) ? ' No people, no human faces.' : '';
  return `Keep this ${STYLES.find((item) => item.id === style)?.label.toLowerCase() ?? 'picture'} the same, but ${change.trim()}. ${STYLE_PROMPTS[style].avoid}.${noPeople}`;
}

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to generate pictures.'); }

/** Makes a square picture with Grok Imagine, or changes an earlier generated one (`sourcePath`). */
export async function generateProfileImage(options: { prompt: string; sourcePath?: string }): Promise<GeneratedImage> {
  desktopOnly();
  return invoke('generate_profile_image', { request: { prompt: options.prompt, sourcePath: options.sourcePath ?? null } });
}
