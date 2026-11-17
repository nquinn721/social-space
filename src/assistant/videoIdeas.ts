import { chat, loadSettings, type ChatMessage } from './grokClient';

export const VIDEO_IDEA_COUNT = 5;
export const VIDEO_PROMPT_LIMIT = 2500;
const MAX_SCENES = 4;

export type VideoIdeaScene = { prompt: string; seconds: number };
export type VideoIdea = { title: string; description: string; scenes: VideoIdeaScene[] };
export type VideoIdeaRequest = { brand: string; notes: string; category: string; durations: number[]; count?: number; exclude?: string[] };

export function videoIdeaMessages(request: VideoIdeaRequest): ChatMessage[] {
  return [
    { role: 'system', content: 'You create distinct, specific short-form social video ideas. Return only JSON. Each scene must be a complete standalone AI video prompt, including action, subject, setting, camera, lighting and sound. Never use existing franchises or real people.' },
    { role: 'user', content: `Create exactly ${request.count ?? VIDEO_IDEA_COUNT} video ideas for ${request.brand}. Brand context: ${request.notes || 'Not provided'}. Category: ${request.category}. Available clip lengths in seconds: ${request.durations.join(', ')}. Each idea may have 1 to ${MAX_SCENES} scenes; every scene is generated separately, so specify a full prompt and one of the available lengths for each. Reply as {"ideas":[{"title":"...","description":"Explain the concept and how scenes fit together","scenes":[{"prompt":"...","seconds":8}]}]}. ${request.exclude?.length ? `Avoid repeating: ${JSON.stringify(request.exclude)}.` : ''}` },
  ];
}

export function readVideoIdeas(text: string, request: VideoIdeaRequest): VideoIdea[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { throw new Error('Grok returned ideas that could not be read. Try again.'); }
  const raw = (parsed as { ideas?: unknown })?.ideas;
  if (!Array.isArray(raw) || raw.length !== (request.count ?? VIDEO_IDEA_COUNT)) throw new Error('Grok did not return the requested number of ideas. Try again.');
  const seen = new Set((request.exclude ?? []).map((item) => item.trim().toLowerCase()));
  return raw.map((item: unknown) => {
    const value = item as Partial<VideoIdea> | null;
    const title = typeof value?.title === 'string' ? value.title.trim().slice(0, 120) : '';
    const description = typeof value?.description === 'string' ? value.description.trim().slice(0, 700) : '';
    const scenes = Array.isArray(value?.scenes) ? value.scenes.map((scene) => ({ prompt: typeof scene?.prompt === 'string' ? scene.prompt.trim() : '', seconds: Number(scene?.seconds) })) : [];
    const key = title.toLowerCase();
    if (!title || !description || seen.has(key) || !scenes.length || scenes.length > MAX_SCENES || scenes.some((scene) => !scene.prompt || scene.prompt.length > VIDEO_PROMPT_LIMIT || !request.durations.includes(scene.seconds))) throw new Error('Grok returned an incomplete idea or an unsupported clip length. Try again.');
    seen.add(key);
    return { title, description, scenes };
  });
}

export async function suggestVideoIdeas(request: VideoIdeaRequest): Promise<VideoIdea[]> {
  const reply = await chat(loadSettings(), videoIdeaMessages(request), []);
  return readVideoIdeas(reply.content, request);
}
