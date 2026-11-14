import { chat, loadSettings, type ChatMessage } from './grokClient';
import { fitDescription } from './suggest';
import { BIO_LIMITS, getPlatform, type Platform } from '../model';

/** Grok's profile copy for one brand: a bio for each social (within its limit) and channel keywords. */
export type ProfileCopy = { bios: Partial<Record<Platform, string>>; keywords: string[] };
export type ProfileBrief = { brand: string; notes?: string; website?: string; platforms: Platform[]; /** Bios already written, kept as the voice to match. */ current?: Partial<Record<Platform, string>> };

/** YouTube keeps channel keywords to 500 characters in all. */
export const KEYWORDS_LIMIT = 500;
const MAX_KEYWORDS = 15;
const MAX_KEYWORD_CHARS = 30;

export const PROFILE_COPY_GUIDE = `You write the profile bios of one brand on several socials, so the brand sounds the same everywhere.

Rules:
- bios: one bio for each social asked for, keyed by its id. Each must fit that social's character limit. Hook first: who it is for and what makes it special, one concrete detail, then a short call to action. Up to 2 fitting emoji. No hashtags. Short socials (TikTok, X) get the tightest version; YouTube gets 2 to 4 sentences about what the channel posts and how often.
- keywords: 6 to 12 search keywords for the YouTube channel, lowercase, 1 to 3 words each, no # signs. Mix what people search for with what makes this brand specific.
- Never name or imitate a real brand or a famous person. Never write filler like "Welcome to our page" or "high quality".

Reply with only one JSON object: {"bios": {"instagram": "...", ...}, "keywords": ["...", ...]}.`;

/** Cleans keywords: no # signs, lowercase, no duplicates, short, and within YouTube's total. */
export function cleanKeywords(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const seen = new Set<string>();
  const kept: string[] = [];
  let total = 0;
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const word = item.replace(/#/g, '').replace(/[,\s]+/g, ' ').trim().toLowerCase();
    if (!word || word.length > MAX_KEYWORD_CHARS || seen.has(word)) continue;
    if (total + word.length + (kept.length ? 2 : 0) > KEYWORDS_LIMIT || kept.length >= MAX_KEYWORDS) break;
    seen.add(word); kept.push(word); total += word.length + (kept.length > 1 ? 2 : 0);
  }
  return kept;
}

/** Splits what someone typed in a keywords box ("calm, massage, #spa") into keywords. */
export const parseKeywords = (text: string) => cleanKeywords(text.split(','));

/** Pulls the bios and keywords out of a model reply, fitting each bio to its social's limit. */
export function parseProfileCopy(text: string, platforms: Platform[]): ProfileCopy | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as { bios?: Record<string, unknown>; keywords?: unknown };
    const bios: ProfileCopy['bios'] = {};
    for (const platform of platforms) {
      const bio = raw.bios?.[platform];
      if (typeof bio !== 'string') continue;
      const clean = bio.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/[ \t]+/g, ' ').trim();
      if (clean) bios[platform] = fitDescription(clean, BIO_LIMITS[platform]);
    }
    const copy = { bios, keywords: cleanKeywords(raw.keywords) };
    return Object.keys(bios).length || copy.keywords.length ? copy : null;
  } catch { return null; }
}

/** Asks Grok for a bio on each of the brand's socials and its channel keywords. */
export async function writeProfileCopy(brief: ProfileBrief): Promise<ProfileCopy> {
  const lines = [`Brand: ${brief.brand}`];
  if (brief.notes?.trim()) lines.push(`About the brand: ${brief.notes.trim()}`);
  if (brief.website?.trim()) lines.push(`Website: ${brief.website.trim()}`);
  lines.push(`Socials (id: character limit): ${brief.platforms.map((platform) => `${platform} (${getPlatform(platform).name}): ${BIO_LIMITS[platform]}`).join(', ')}`);
  const current = Object.entries(brief.current ?? {}).filter(([, bio]) => bio?.trim());
  if (current.length) lines.push(`Bios written so far (keep their voice and facts): ${current.map(([platform, bio]) => `${platform}: ${bio}`).join(' | ')}`);
  const messages: ChatMessage[] = [{ role: 'system', content: PROFILE_COPY_GUIDE }, { role: 'user', content: lines.join('\n') }];
  const settings = loadSettings();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await chat(settings, messages, []);
    const copy = parseProfileCopy(reply.content ?? '', brief.platforms);
    if (copy) return copy;
    messages.push({ role: 'assistant', content: reply.content ?? '' }, { role: 'user', content: 'Reply with only the JSON object.' });
  }
  throw new Error('The assistant did not write anything usable. Check the assistant under Settings, then try again.');
}

/** One request per brand while the app runs, so opening a panel again shows the same suggestions without paying twice. */
const cache = new Map<string, Promise<ProfileCopy>>();
export function cachedProfileCopy(key: string, brief: ProfileBrief, fresh = false): Promise<ProfileCopy> {
  const id = `${key}:${[...brief.platforms].sort().join(',')}`;
  const known = cache.get(id);
  if (known && !fresh) return known;
  const request = writeProfileCopy(brief);
  cache.set(id, request);
  request.catch(() => { if (cache.get(id) === request) cache.delete(id); });
  return request;
}
