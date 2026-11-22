import { chat, loadSettings } from './grokClient';
import { getPlatform, type Platform } from '../model';

export const REPLY_GUIDE = `You answer comments on a brand's short videos, as the brand.

Rules:
- One reply, 1 or 2 short sentences, warm and natural, in the commenter's language.
- Answer what they said or asked. Thank them only when it fits; never only "Thanks!".
- At most 1 emoji. No hashtags, no links, never ask for follows or likes.
- If the comment is rude, spam or a scam, reply with exactly SKIP.

Reply with only the reply text.`;

/** Grok's draft of the brand's answer to one comment; null when the comment is better left alone. */
export async function draftReply(input: { brand: string; video: string; platform: Platform; author: string; comment: string }): Promise<string | null> {
  const answer = await chat(loadSettings(), [
    { role: 'system', content: REPLY_GUIDE },
    { role: 'user', content: `Brand: ${input.brand}\nVideo: ${input.video}\nSocial: ${getPlatform(input.platform).name}\nComment from ${input.author}: ${input.comment}` },
  ], []);
  const text = answer.content.trim().replace(/^"|"$/g, '');
  return !text || text === 'SKIP' ? null : text.slice(0, 2000);
}
