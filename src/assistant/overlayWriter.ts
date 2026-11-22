import { chat, loadSettings, type ChatMessage } from './grokClient';
import type { TextAnimation } from '../model';

export type OverlayLine = { text: string; animation: TextAnimation };
export type OverlayRequest = {
  brand: string; notes?: string; category: string; title: string; prompt?: string;
  /** What Nate wants the text to be, like "inspirational quotes". */
  direction?: string;
  /** Each moment that gets one text, [start, end] in seconds. */
  beats: [number, number][];
  /** Texts already written, to avoid when rewriting one. */
  avoid?: string[];
};
const ANIMATION_IDS: TextAnimation[] = ['fade', 'pop', 'slide', 'typewriter'];
export const OVERLAY_TEXT_LIMIT = 70;

export const OVERLAY_GUIDE = `You write the on-screen text for short vertical social videos (Reels, TikTok, Shorts).
Each line shows on the video for a few seconds, so it must be short enough to read in that time: about 2 to 3 words per second, at most ${OVERLAY_TEXT_LIMIT} characters.
The lines are read in order and together should feel like one message with a hook first and a payoff last. Match the brand's voice and the category. No hashtags. At most one emoji in the whole set.
For each line also pick an animation: "pop" for punchy hooks, "typewriter" for quotes or thoughts, "fade" for calm lines, "slide" for steps or lists.
Reply with only one JSON object: {"lines":[{"text":"...","animation":"fade"}]} with exactly as many lines as asked.`;

export function overlayMessages(request: OverlayRequest): ChatMessage[] {
  const lines = [`Brand: ${request.brand}`];
  if (request.notes?.trim()) lines.push(`About the brand: ${request.notes.trim().slice(0, 1500)}`);
  lines.push(`Category: ${request.category}`, `Video title: ${request.title}`);
  if (request.prompt?.trim()) lines.push(`What the video shows: ${request.prompt.trim().slice(0, 1500)}`);
  if (request.direction?.trim()) lines.push(`What the text should be: ${request.direction.trim().slice(0, 500)}`);
  lines.push(`Write ${request.beats.length} line${request.beats.length === 1 ? '' : 's'}, one for each moment: ${request.beats.map(([start, end], index) => `${index + 1}) ${start.toFixed(1)}s to ${end.toFixed(1)}s (${(end - start).toFixed(1)} seconds)`).join('; ')}.`);
  if (request.avoid?.length) lines.push(`Don't repeat these: ${request.avoid.map((text) => JSON.stringify(text)).join(', ')}.`);
  return [{ role: 'system', content: OVERLAY_GUIDE }, { role: 'user', content: lines.join('\n') }];
}

/** Reads Grok's reply; null when it isn't the JSON asked for or has the wrong number of lines. */
export function readOverlayLines(text: string, count: number): OverlayLine[] | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = (JSON.parse(match[0]) as { lines?: unknown }).lines;
    if (!Array.isArray(raw) || raw.length !== count) return null;
    const lines = raw.map((item) => {
      const value = item as { text?: unknown; animation?: unknown } | null;
      const text = typeof value?.text === 'string' ? value.text.replace(/#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, OVERLAY_TEXT_LIMIT + 30) : '';
      const animation = ANIMATION_IDS.includes(value?.animation as TextAnimation) ? value?.animation as TextAnimation : 'fade';
      return { text, animation };
    });
    return lines.every((line) => line.text) ? lines : null;
  } catch { return null; }
}

/** Asks Grok for one on-screen text per moment of the video. */
export async function writeOverlays(request: OverlayRequest): Promise<OverlayLine[]> {
  const messages = overlayMessages(request);
  const settings = loadSettings();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await chat(settings, messages, []);
    const lines = readOverlayLines(reply.content ?? '', request.beats.length);
    if (lines) return lines;
    messages.push({ role: 'assistant', content: reply.content ?? '' }, { role: 'user', content: `Reply with only the JSON object, with exactly ${request.beats.length} lines.` });
  }
  throw new Error('Grok did not write usable text. Try again.');
}
