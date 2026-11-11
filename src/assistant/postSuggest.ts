import { chat, loadSettings, type ChatMessage } from './ollamaClient';
import { parseHashtags } from '../postDetails';

export type PostSuggestion = { description: string; hashtags: string[] };
export type PostIdea = { brand: string; category: string; title: string; prompt?: string; socials: string[]; currentHashtags?: string[]; limit: number };

export const POST_GUIDE = `You write captions for short vertical videos on Instagram Reels, TikTok, YouTube Shorts and X.

Rules:
- description: 1 to 2 short sentences about what happens in this video, warm and specific, with at most one emoji. Hook first. No hashtags in it.
- hashtags: 5 to 12 hashtags without the # sign. Mix 2 or 3 broad ones people search (like pets or cute) with specific ones for this video. Lowercase, letters and numbers only, no spaces.

Reply with only one JSON object with the keys "description" (a string) and "hashtags" (an array of strings).`;

const EXAMPLE_IDEA = 'Brand: Animals\nCategory: Goat\nVideo title: Baby goat jumps on a hay bale\nWhat the video shows: a tiny brown goat kid bounces onto a hay bale in a sunny barn and wobbles\nSocials: Instagram, TikTok';
const EXAMPLE_REPLY = JSON.stringify({ description: 'This tiny goat just discovered hay bales and has zero chill 🐐 Wait for the wobble.', hashtags: ['goats', 'babygoat', 'goatsoftiktok', 'farmlife', 'cuteanimals', 'barn', 'funnyanimals'] });

/** Pulls the first JSON object out of a model reply, tolerating code fences or extra words. */
export function parsePostSuggestion(text: string): PostSuggestion | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const description = typeof raw.description === 'string' ? raw.description.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/[ \t]+/g, ' ').trim() : '';
    const hashtags = Array.isArray(raw.hashtags) ? parseHashtags(raw.hashtags.filter((tag): tag is string => typeof tag === 'string').join(' '))
      : typeof raw.hashtags === 'string' ? parseHashtags(raw.hashtags) : [];
    return description || hashtags.length ? { description, hashtags: hashtags.slice(0, 30) } : null;
  } catch { return null; }
}

/** Asks the local model for a description and hashtags for one video. */
export async function suggestPost(idea: PostIdea): Promise<PostSuggestion> {
  const lines = [`Brand: ${idea.brand}`, `Category: ${idea.category}`, `Video title: ${idea.title}`];
  if (idea.prompt?.trim()) lines.push(`What the video shows: ${idea.prompt.trim()}`);
  if (idea.socials.length) lines.push(`Socials: ${idea.socials.join(', ')}`);
  if (idea.currentHashtags?.length) lines.push(`Hashtags this category usually uses (keep the good ones): ${idea.currentHashtags.join(' ')}`);
  lines.push(`The description plus hashtags must fit in ${idea.limit} characters.`);
  const messages: ChatMessage[] = [
    { role: 'system', content: POST_GUIDE },
    { role: 'user', content: EXAMPLE_IDEA },
    { role: 'assistant', content: EXAMPLE_REPLY },
    { role: 'user', content: lines.join('\n') },
  ];
  const settings = { ...loadSettings(), think: false };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await chat(settings, messages, []);
    const suggestion = parsePostSuggestion(reply.content ?? '');
    if (suggestion) return suggestion;
    messages.push({ role: 'assistant', content: reply.content ?? '' }, { role: 'user', content: 'Reply with only the JSON object.' });
  }
  throw new Error('The assistant did not suggest anything usable. Check that Ollama is running under Settings, then try again.');
}
