import { chat, loadSettings, type ChatMessage } from './ollamaClient';
import type { ImageStyle } from '../imageAiService';

export type ProfileSuggestion = { name: string; username: string; displayName: string; description: string; imagePrompt: string; imageStyle: ImageStyle };

const IMAGE_STYLES: ImageStyle[] = ['photo', 'illustration', 'logo'];

/**
 * Small local models write flat, generic copy unless told what good looks like,
 * so this spells out the craft and shows one worked example.
 */
export const PROFILE_GUIDE = `You are a social media brand strategist who sets up standout accounts for small businesses and creators.

Write like the best accounts on Instagram and TikTok: specific, warm, a little playful, never corporate.

Rules for each field:
- name: 1 to 3 words, memorable and evocative, says the vibe or the product. No generic words like "Shop", "Store", "Official", "Company". Never a real brand or a famous person's name.
- username: short and brandable, matches the name, lowercase, only letters, numbers, dots or underscores, at most 24 characters. Avoid random numbers.
- displayName: the name plus a short searchable keyword after a separator, like "Soft Wings | Kids Jewelry". At most 30 characters.
- description: the profile bio. Start with a hook that says who it is for and what makes it special. Add one concrete, sensory detail (materials, place, process, price point or promise). End with a short call to action, like "New drops every Friday" or "Tap to shop". You may use up to 2 fitting emoji and line breaks. No hashtags. Never use filler like "Welcome to our page", "high quality", "best products", "we are passionate".
- imagePrompt: 20 to 40 words describing the ideal profile picture: the subject, look, colors, background and mood. It must read well as a small circle. For a personal brand or creator, describe a made-up person (age range, look, expression, outfit, setting). For a product business, describe a simple logo mark or a styled product close-up. Never name or imitate a real or famous person.
- imageStyle: "photo" for a person or product photo, "illustration" for a drawn character, "logo" for a logo mark.

Reply with only one JSON object with the string keys "name", "username", "displayName", "description", "imagePrompt", "imageStyle".`;

const EXAMPLE_IDEA = 'Idea: sourdough bakery run from home in Vermont\nSocials: Instagram, TikTok\nThe description must be at most 150 characters.';
const EXAMPLE_REPLY = JSON.stringify({
  name: 'Crumb & Crust',
  username: 'crumbandcrust.vt',
  displayName: 'Crumb & Crust | Sourdough',
  description: 'Slow-fermented sourdough from a tiny Vermont kitchen 🍞\n48-hour loaves, crackly crust, open crumb.\nWeekend preorders open Thursday ↓',
  imagePrompt: 'overhead close-up of a rustic sourdough loaf with a deep golden ear and flour dusting, on a linen cloth, warm morning window light, cream and honey tones, cozy and inviting',
  imageStyle: 'photo',
});

/** Pulls the first JSON object out of a model reply, tolerating code fences or extra words. */
export function parseSuggestion(text: string): ProfileSuggestion | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const pick = (key: string) => typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
    const style = pick('imageStyle').toLowerCase() as ImageStyle;
    const suggestion = { name: pick('name'), username: pick('username').replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '').toLowerCase(), displayName: pick('displayName'), description: pick('description'), imagePrompt: pick('imagePrompt'), imageStyle: IMAGE_STYLES.includes(style) ? style : 'photo' };
    return suggestion.name && suggestion.description ? suggestion : null;
  } catch { return null; }
}

/** Shortens a description to the limit at a line, sentence or word break, so a near miss is still usable. */
export function fitDescription(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const pieces = text.split(/(?<=[.!?\n])\s*/).map((piece) => piece.trim()).filter(Boolean);
  let kept = '';
  for (const piece of pieces) { const next = kept ? `${kept}\n${piece}` : piece; if (next.length > limit) break; kept = next; }
  if (kept) return kept;
  const cut = text.slice(0, limit + 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trim();
}

/** Asks the local model for an account name, username, display name, description and picture idea. */
export async function suggestProfile(idea: string, limit: number, socials: string[]): Promise<ProfileSuggestion> {
  const settings = loadSettings();
  const messages: ChatMessage[] = [
    { role: 'system', content: PROFILE_GUIDE },
    { role: 'user', content: EXAMPLE_IDEA },
    { role: 'assistant', content: EXAMPLE_REPLY },
    { role: 'user', content: `Idea: ${idea}\nSocials: ${socials.join(', ')}\nThe description must be at most ${limit} characters. Make it as distinctive as the example, but about this idea only.` },
  ];
  let best: ProfileSuggestion | null = null;
  let picture: Pick<ProfileSuggestion, 'imagePrompt' | 'imageStyle'> | null = null;
  // Retries for length sometimes drop the picture idea, so keep the first one the model gave.
  const withPicture = (suggestion: ProfileSuggestion) => suggestion.imagePrompt || !picture ? suggestion : { ...suggestion, ...picture };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = await chat(settings, messages, []);
    const suggestion = parseSuggestion(reply.content ?? '');
    if (suggestion?.imagePrompt && !picture) picture = { imagePrompt: suggestion.imagePrompt, imageStyle: suggestion.imageStyle };
    if (suggestion && suggestion.description.length <= limit) return withPicture(suggestion);
    if (suggestion && (!best || suggestion.description.length < best.description.length)) best = suggestion;
    messages.push({ role: 'assistant', content: reply.content ?? '' }, { role: 'user', content: suggestion ? `That description is ${suggestion.description.length} characters. Keep the hook and call to action but make it at most ${limit}. Reply with the full JSON object, all six keys.` : 'Reply with only the JSON object.' });
  }
  if (best) return withPicture({ ...best, description: fitDescription(best.description, limit) });
  throw new Error('The model did not give a usable suggestion. Try again or reword the idea.');
}
