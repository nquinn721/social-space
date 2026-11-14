import { chat, loadSettings, type ChatMessage } from './assistant/grokClient';
import type { Series, SeriesCharacter, SeriesEpisode } from './model';
import { MAX_EPISODES, MIN_EPISODES, partLabel, recapBefore } from './series';

/**
 * Grok writes every series: the story bible, the cast, the episode arc, then each episode's script
 * with a recap of what came before. Grok is always the writer, whatever video source makes the clips.
 */

export type SeriesPlan = Pick<Series, 'title' | 'bible' | 'style'> & { characters: Omit<SeriesCharacter, 'id' | 'imageFile'>[]; episodes: Pick<SeriesEpisode, 'title' | 'summary'>[] };
export type EpisodeDraft = Pick<SeriesEpisode, 'script' | 'videoPrompt' | 'caption'>;
export type PlanRequest = { brandName: string; brandNotes: string; premise: string; episodes: number; seconds: number };

const WRITER = 'You write short serialized stories for social video (TikTok, Reels, Shorts). Each part is one short AI-generated clip. '
  + 'Keep characters, look and facts consistent across parts, end every part but the last on a hook, and keep it suitable for all audiences. '
  + 'Characters are fictional: never real people or existing franchise characters. Answer with JSON only, no markdown.';
const MAX_TEXT = 4_000;

/** The first JSON object in a reply, also when Grok wraps it in a ```json fence or adds a line around it. */
export function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Grok did not send back a story. Try again.');
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* falls through to the error below */ }
  throw new Error('Grok sent back a story that could not be read. Try again.');
}

const str = (value: unknown, max = MAX_TEXT) => (typeof value === 'string' ? value.trim() : '').slice(0, max);
const list = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');

/** Checks and trims Grok's plan; the arc has exactly `episodes` parts. */
export function readPlan(reply: Record<string, unknown>, episodes: number): SeriesPlan {
  const characters = list(reply.characters).map((item) => ({ name: str(item.name, 60), description: str(item.description, 500) })).filter((item) => item.name).slice(0, 8);
  const parts = list(reply.episodes).map((item) => ({ title: str(item.title, 100), summary: str(item.summary, 800) })).filter((item) => item.summary);
  if (!str(reply.title) || !str(reply.bible) || parts.length < Math.min(episodes, MIN_EPISODES)) throw new Error('Grok sent back an incomplete story. Try again.');
  return { title: str(reply.title, 100), bible: str(reply.bible), style: str(reply.style, 300), characters, episodes: parts.slice(0, episodes) };
}

export function readEpisode(reply: Record<string, unknown>): EpisodeDraft {
  const draft = { script: str(reply.script), videoPrompt: str(reply.videoPrompt, 1_800), caption: str(reply.caption, 1_000) };
  if (!draft.script || !draft.videoPrompt) throw new Error('Grok sent back an incomplete script. Try again.');
  return draft;
}

export function planMessages(request: PlanRequest): ChatMessage[] {
  const count = Math.max(MIN_EPISODES, Math.min(MAX_EPISODES, Math.round(request.episodes)));
  return [
    { role: 'system', content: WRITER },
    { role: 'user', content: [
      `Plan a ${count}-part video series for the brand "${request.brandName}".${request.brandNotes.trim() ? ` About the brand: ${request.brandNotes.trim()}` : ''}`,
      `Premise: ${request.premise.trim()}`,
      `Each part is one clip of about ${request.seconds} seconds, so each part shows one clear moment.`,
      'Reply with JSON: {"title": series title, "bible": story bible (world, tone, rules, how it ends; under 1500 characters), '
        + '"style": one line describing the visual look every clip shares, '
        + '"characters": [{"name", "description": fixed look (age, build, hair, clothes, colors) so a picture can be drawn of them}] (1 to 4 recurring characters), '
        + `"episodes": [{"title", "summary": what happens in this part, 1 to 3 sentences}] with exactly ${count} parts in order}.`,
    ].join('\n') },
  ];
}

export function episodeMessages(series: Series, episode: SeriesEpisode): ChatMessage[] {
  const total = series.episodes.length;
  const recap = recapBefore(series, episode.number);
  const next = series.episodes.find((item) => item.number === episode.number + 1);
  const cast = series.characters.map((character) => `- ${character.name}: ${character.description}`).join('\n');
  return [
    { role: 'system', content: WRITER },
    { role: 'user', content: [
      `Series: "${series.title}"`,
      `Story bible: ${series.bible}`,
      series.style ? `Look: ${series.style}` : '',
      cast ? `Characters:\n${cast}` : '',
      recap ? `Story so far:\n${recap}` : 'This is the first part.',
      `Now write ${partLabel(episode.number, total)} "${episode.title}": ${episode.summary}`,
      next ? `The next part will be: ${next.summary}` : 'This is the final part: resolve the story.',
      `The clip is about ${series.duration} seconds.`,
      'Reply with JSON: {"script": the scene with any short spoken lines, written for this one clip, '
        + (episode.number > 1 ? 'opening with a one-line recap of the story so far, ' : '')
        + '"videoPrompt": what the video model should show, in present tense: setting, each character by name doing what, camera, mood (under 1200 characters, no dialogue quotes longer than one line), '
        + '"caption": a short post caption for this part that hooks viewers to watch the next part, no hashtags}.',
    ].filter(Boolean).join('\n\n') },
  ];
}

export async function planSeries(request: PlanRequest): Promise<SeriesPlan> {
  const reply = await chat(loadSettings(), planMessages(request), []);
  return readPlan(parseJson(reply.content), Math.max(MIN_EPISODES, Math.min(MAX_EPISODES, request.episodes)));
}

export async function writeEpisode(series: Series, episode: SeriesEpisode): Promise<EpisodeDraft> {
  const reply = await chat(loadSettings(), episodeMessages(series, episode), []);
  return readEpisode(parseJson(reply.content));
}

/** The prompt for a character's reference picture: one fictional character, full figure, plain background. */
export function characterPicturePrompt(series: Pick<Series, 'style'>, character: Pick<SeriesCharacter, 'name' | 'description'>) {
  return [
    `Character reference sheet of a fictional character named ${character.name}: ${character.description.trim() || 'as described in the story'}`,
    series.style?.trim() ? `in this look: ${series.style.trim()}` : '',
    'full figure, facing the camera, plain light background, even lighting, a single character, no text, no watermark',
  ].filter(Boolean).join(', ');
}
