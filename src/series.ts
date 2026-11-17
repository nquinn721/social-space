import { getPlatform, type Platform, type Series, type SeriesCharacter, type SeriesEpisode, type Video, type Workspace } from './model';

/** Most character pictures a Grok clip takes at once (grok-imagine-video). */
export const MAX_REFERENCES = 7;
/** Longest clip Grok makes when it is given character pictures. */
export const MAX_REFERENCE_SECONDS = 10;
/** Video sources reject longer prompts. */
export const MAX_VIDEO_PROMPT = 3_000;
export const MIN_EPISODES = 2;
export const MAX_EPISODES = 12;
/** A new story starts small; an existing story can grow over time. */
export const MAX_STORY_PARTS = 100;
export const DEFAULT_EPISODES = 4;
export const DEFAULT_SECONDS = 10;

export function partLabel(number: number, total: number) { return `Part ${number} of ${total}`; }

export function seriesOf(workspace: Workspace, id: string | undefined): Series | undefined {
  return id ? workspace.series?.find((series) => series.id === id) : undefined;
}

/** The video made for an episode, if any: the newest one that didn't fail, else the newest failed try. */
export function episodeVideo(workspace: Workspace, series: Series, number: number): Video | undefined {
  const tries = (workspace.videos ?? []).filter((video) => video.seriesId === series.id && video.episode === number).sort((a, b) => b.createdAt - a.createdAt);
  return tries.find((video) => video.generation?.status !== 'failed') ?? tries[0];
}

/** What happened before this episode, in order, for the script writer and for viewers' recaps. */
export function recapBefore(series: Series, number: number): string {
  return series.episodes
    .filter((episode) => episode.number < number)
    .sort((a, b) => a.number - b.number)
    .map((episode) => `${partLabel(episode.number, series.episodes.length)} "${episode.title}": ${episode.summary}`)
    .join('\n');
}

/** The caption a series episode posts with: "Part 2 of 5 · The Lost Key", then the episode's own text. */
export function episodeCaption(series: Series, episode: SeriesEpisode): string {
  const head = `${partLabel(episode.number, series.episodes.length)} · ${series.title}`;
  const body = episode.caption?.trim() ?? '';
  return body ? `${head}\n\n${body}` : head;
}

export function episodeTitle(series: Series, episode: SeriesEpisode) {
  return `${series.title}: ${partLabel(episode.number, series.episodes.length)}`;
}

const mentions = (text: string, name: string) => !!name.trim() && new RegExp(`\\b${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

/** The characters who appear in an episode: those named in its prompt or summary, else the whole cast. */
export function castOf(series: Series, episode: SeriesEpisode): SeriesCharacter[] {
  const text = `${episode.videoPrompt ?? ''}\n${episode.summary}\n${episode.script ?? ''}`;
  const named = series.characters.filter((character) => mentions(text, character.name));
  return named.length ? named : series.characters;
}

/**
 * What the video source is sent for one episode. With pictures, each pictured character is tied to
 * its picture (<IMAGE_n>) so they look the same in every part; without, they are described in words.
 */
export function episodeRequest(series: Series, episode: SeriesEpisode, useReferences: boolean): { prompt: string; references: string[] } {
  const cast = castOf(series, episode);
  const pictured = useReferences ? cast.filter((character) => character.imageFile).slice(0, MAX_REFERENCES) : [];
  const lines = cast.map((character) => {
    const index = pictured.indexOf(character);
    const look = character.description.trim();
    return index >= 0 ? `${character.name} is the character from <IMAGE_${index}>${look ? ` (${look})` : ''}.` : `${character.name}: ${look || 'as before'}.`;
  });
  const style = series.style?.trim();
  const parts = [
    lines.length ? `Characters: ${lines.join(' ')}` : '',
    style ? `Look: ${style}.` : '',
    (episode.videoPrompt || episode.summary).trim(),
  ].filter(Boolean);
  return { prompt: parts.join('\n').slice(0, MAX_VIDEO_PROMPT), references: pictured.map((character) => character.imageFile!) };
}

/** The first earlier part of this video's series that isn't up on a social yet, or null when it can go. */
export function earlierPartMissing(workspace: Workspace, video: Video, platform: Platform): number | null {
  const series = seriesOf(workspace, video.seriesId);
  if (!series || !video.episode) return null;
  for (let number = 1; number < video.episode; number++) {
    if (!episodeVideo(workspace, series, number)?.posted.includes(platform)) return number;
  }
  return null;
}

/**
 * Why this video can't go up on a social yet: an earlier part of its series isn't posted there,
 * so followers would see the story out of order. Null when it can go.
 */
export function waitingOnEarlierPart(workspace: Workspace, video: Video, platform: Platform): string | null {
  const series = seriesOf(workspace, video.seriesId);
  const number = earlierPartMissing(workspace, video, platform);
  return series && number ? `Post ${partLabel(number, series.episodes.length)} of ${series.title} on ${getPlatform(platform).name} first, so the story goes up in order.` : null;
}

/** "Part 2 of 5" for a series video, or null. */
export function videoPartLabel(workspace: Workspace, video: Video): string | null {
  const series = seriesOf(workspace, video.seriesId);
  return series && video.episode ? partLabel(video.episode, series.episodes.length) : null;
}

/** The next episode to post on each social: the first one not up there yet. */
export function nextToPost(workspace: Workspace, series: Series, socials: Platform[]): { platform: Platform; number: number | null }[] {
  return socials.map((platform) => {
    const next = [...series.episodes].sort((a, b) => a.number - b.number).find((episode) => !episodeVideo(workspace, series, episode.number)?.posted.includes(platform));
    return { platform, number: next?.number ?? null };
  });
}

/** Where a series stands: scripts written, clips made, parts posted everywhere. */
export function seriesProgress(workspace: Workspace, series: Series, socials: Platform[]) {
  const videos = series.episodes.map((episode) => episodeVideo(workspace, series, episode.number));
  return {
    total: series.episodes.length,
    scripted: series.episodes.filter((episode) => episode.script?.trim()).length,
    made: videos.filter((video) => video && !video.generation).length,
    posted: videos.filter((video) => video && socials.length > 0 && socials.every((platform) => video.posted.includes(platform))).length,
  };
}

/** Removes a series, its episodes' link on their videos (the videos stay in the library). */
export function withoutSeries(workspace: Workspace, id: string): Workspace {
  return {
    ...workspace,
    series: (workspace.series ?? []).filter((series) => series.id !== id),
    videos: (workspace.videos ?? []).map((video) => video.seriesId === id ? { ...video, seriesId: undefined, episode: undefined } : video),
  };
}

export function replaceSeries(workspace: Workspace, series: Series): Workspace {
  const all = workspace.series ?? [];
  return { ...workspace, series: all.some((item) => item.id === series.id) ? all.map((item) => item.id === series.id ? series : item) : [...all, series] };
}

export function replaceEpisode(series: Series, episode: SeriesEpisode): Series {
  return { ...series, episodes: series.episodes.map((item) => item.id === episode.id ? episode : item) };
}
