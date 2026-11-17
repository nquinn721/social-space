import { chat, loadSettings, type ChatMessage } from './grokClient';

export const BRAND_IDEA_COUNT = 5;
export const BRAND_IDEA_MAX_LENGTH = 500;

export type BrandIdeaOptions = {
  /** An optional direction from the user's idea field. */
  context?: string;
  /** Current choices to avoid repeating during a reroll. */
  exclude?: string[];
  /** Use one to replace a single choice; the default creates five. */
  count?: number;
};

const IDEA_GUIDE = `Suggest distinct, specific ideas for a social media brand or creator account.
Each idea should be a concise, practical concept that a person could paste into a form to generate a name and profile.
Vary the audience, topic, or angle; avoid repeating an idea or imitating a famous person or existing brand.
Respond with only a JSON array of strings. Do not return markdown, commentary, or other fields.`;

const identity = (idea: string) => idea.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Read a JSON array even if a model wraps it in a code fence or brief introduction. */
export function parseBrandIdeas(text: string): string[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
    return value.map((item: string) => item.trim());
  } catch { return null; }
}

/** One explicit request per click; errors never silently trigger additional paid requests. */
export async function suggestBrandIdeas({ context = '', exclude = [], count = BRAND_IDEA_COUNT }: BrandIdeaOptions = {}): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > BRAND_IDEA_COUNT) throw new Error('Choose between one and five ideas.');
  const direction = context.trim();
  if (direction.length > BRAND_IDEA_MAX_LENGTH) throw new Error('Your idea is too long. Shorten it and try again.');
  const current = exclude.map((idea) => idea.trim()).filter(Boolean);
  const messages: ChatMessage[] = [
    { role: 'system', content: IDEA_GUIDE },
    { role: 'user', content: `Give me exactly ${count} different brand ${count === 1 ? 'idea' : 'ideas'}, each at most ${BRAND_IDEA_MAX_LENGTH} characters.\n${direction ? `Direction: ${direction}` : 'Explore a variety of appealing niches and audiences.'}${current.length ? `\nDo not repeat these existing ideas: ${JSON.stringify(current)}` : ''}` },
  ];
  const reply = await chat(loadSettings(), messages, []);
  const ideas = parseBrandIdeas(reply.content ?? '');
  const used = new Set(current.map(identity));
  if (!ideas || ideas.length !== count || ideas.some((idea) => {
    const key = identity(idea);
    if (!key || idea.length > BRAND_IDEA_MAX_LENGTH || used.has(key)) return true;
    used.add(key);
    return false;
  })) throw new Error('Could not get distinct, usable ideas. Please try again.');
  return ideas;
}
