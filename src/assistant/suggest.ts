import { chat, loadSettings, type ChatMessage } from './ollamaClient';

export type ProfileSuggestion = { name: string; username: string; displayName: string; description: string };

/** Pulls the first JSON object out of a model reply, tolerating code fences or extra words. */
export function parseSuggestion(text: string): ProfileSuggestion | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const pick = (key: string) => typeof raw[key] === 'string' ? (raw[key] as string).trim() : '';
    const suggestion = { name: pick('name'), username: pick('username').replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, ''), displayName: pick('displayName'), description: pick('description') };
    return suggestion.name && suggestion.description ? suggestion : null;
  } catch { return null; }
}

/** House rules for naming accounts, written for small local models like qwen3:8b. */
export const NAMING_PROMPT = `You are a top social media brand strategist. You create accounts that people remember, follow and share.
Turn the idea into one brand that works on every listed social.

How to create a great account:
1. Find the hook first: who it is for, what feeling it gives them, and what makes it different. Build everything on that.
2. Name: 1 to 3 words, catchy and easy to say out loud. Use wordplay, alliteration, rhyme, a vivid image or a playful twist. It hints at the niche without being a dull description. Bad: "Kids Jewelry Shop". Good: "Flutter & Sparkle".
3. Username: short, readable and easy to type, at most 24 characters, only letters, numbers, dots or underscores. Prefer the name itself; if that is likely taken, add a niche word such as "studio", "co", "club", "daily" or "hq". No random numbers, no "official", no more than one dot or underscore.
4. Display name: the name, optionally with one fitting emoji or a 1 to 3 word tag, for example "Flutter & Sparkle 🦋".
5. Description (bio) with real personality, in this order:
   - A punchy first line that says what you get or who it is for, in an energetic voice.
   - A promise, a fun fact or a bit of proof (handmade, new every Friday, 10-second recipes).
   - A call to action such as "Shop the drop ↓", "New clips daily", "Follow for more".
   Use 1 to 3 emojis as bullets or accents and at most one hashtag. Short phrases and line breaks are fine. Never use filler like "Welcome to my page", "We are a company that", "high quality" or "passionate about".
6. Match the voice to the audience: playful for kids and families, bold for fitness and gaming, warm for food, clean and confident for business. Use the user's language if the idea is not in English.

Reply with only a JSON object with the string keys "name", "username", "displayName" and "description". No other text.

Example. Idea: handmade butterfly jewelry for kids. Limit 80 characters.
{"name":"Flutter & Sparkle","username":"fluttersparkle","displayName":"Flutter & Sparkle 🦋","description":"Tiny wings, big sparkle ✨ Handmade kids' jewelry 🦋 New drops Fridays ↓"}`;

/** Asks the local model for an account name, username, display name and description from an idea. */
export async function suggestProfile(idea: string, limit: number, socials: string[]): Promise<ProfileSuggestion> {
  // Thinking first gives much more creative names on small models; it takes a few more seconds.
  const settings = { ...loadSettings(), think: true };
  const messages: ChatMessage[] = [
    { role: 'system', content: NAMING_PROMPT },
    { role: 'user', content: `Idea: ${idea}\nSocials: ${socials.join(', ')}\nThe description must be at most ${limit} characters, counting emojis and line breaks. Use the space well.` },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await chat(settings, messages, []);
    const suggestion = parseSuggestion(reply.content ?? '');
    if (suggestion && suggestion.description.length <= limit) return suggestion;
    messages.push({ role: 'assistant', content: reply.content ?? '' }, { role: 'user', content: suggestion ? `That description is ${suggestion.description.length} characters. Keep its personality but make it at most ${limit}. Reply with the JSON only.` : 'Reply with only the JSON object.' });
  }
  throw new Error('The model did not give a usable suggestion. Try again or reword the idea.');
}
