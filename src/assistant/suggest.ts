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

/** Asks the local model for an account name, username, display name and description from an idea. */
export async function suggestProfile(idea: string, limit: number, socials: string[]): Promise<ProfileSuggestion> {
  const settings = loadSettings();
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You name social media accounts for a small business. Reply with only a JSON object with string keys "name", "username", "displayName", "description". The username uses only letters, numbers, dots or underscores, at most 24 characters. The description is friendly, specific, and has no hashtags.' },
    { role: 'user', content: `Idea: ${idea}\nSocials: ${socials.join(', ')}\nThe description must be at most ${limit} characters.` },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await chat(settings, messages, []);
    const suggestion = parseSuggestion(reply.content ?? '');
    if (suggestion && suggestion.description.length <= limit) return suggestion;
    messages.push({ role: 'assistant', content: reply.content ?? '' }, { role: 'user', content: suggestion ? `That description is ${suggestion.description.length} characters. Make it at most ${limit}. Reply with the JSON only.` : 'Reply with only the JSON object.' });
  }
  throw new Error('The model did not give a usable suggestion. Try again or reword the idea.');
}
