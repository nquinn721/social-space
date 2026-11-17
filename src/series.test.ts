import { describe, expect, it } from 'vitest';
import type { Series, Video, Workspace } from './model';
import { castOf, earlierPartMissing, episodeCaption, episodeRequest, episodeVideo, MAX_REFERENCES, nextToPost, recapBefore, replaceEpisode, seriesProgress, videoPartLabel, waitingOnEarlierPart, withoutSeries } from './series';
import { episodeMessages, parseJson, planMessages, readEpisode, readPlan, characterPicturePrompt } from './seriesWriter';

const story: Series = {
  id: 's', brandId: 'b', categoryId: 'c', title: 'The Lost Key', premise: 'A rabbit loses a key.', bible: 'Pip the rabbit searches the meadow.', style: 'soft pastel 3D animation',
  characters: [{ id: 'k1', name: 'Pip', description: 'small white rabbit, red scarf', imageFile: 'pip.jpg' }, { id: 'k2', name: 'Bramble', description: 'grumpy badger' }],
  episodes: [
    { id: 'e1', number: 1, title: 'Gone', summary: 'Pip finds the key is gone.', script: 'Pip gasps.', videoPrompt: 'Pip searches a burrow.', caption: 'Where did it go?' },
    { id: 'e2', number: 2, title: 'Clue', summary: 'Bramble has a clue.', videoPrompt: 'Pip meets Bramble by the river.' },
    { id: 'e3', number: 3, title: 'Found', summary: 'Pip finds it.' },
  ],
  aspectRatio: '9:16', duration: 10, createdAt: 1,
};
const clip = (episode: number, posted: Video['posted'] = [], extra: Partial<Video> = {}): Video => ({ id: `v${episode}${extra.createdAt ?? ''}`, brandId: 'b', categoryId: 'c', title: `Part ${episode}`, mediaSource: '', caption: '', posted, createdAt: 1, seriesId: 's', episode, ...extra });
const workspace = (videos: Video[]): Workspace => ({ businessName: '', brands: [{ id: 'b', name: 'Mia', notes: '' }], accounts: [], channels: [], categories: [{ id: 'c', brandId: 'b', name: 'Stories' }], videos, series: [story] });

describe('series', () => {
  it('captions each part as Part N of M with the series title', () => {
    expect(episodeCaption(story, story.episodes[0])).toBe('Part 1 of 3 · The Lost Key\n\nWhere did it go?');
    expect(episodeCaption(story, story.episodes[1])).toBe('Part 2 of 3 · The Lost Key');
  });

  it('recaps only the parts before an episode, in order', () => {
    expect(recapBefore(story, 1)).toBe('');
    expect(recapBefore(story, 3)).toBe('Part 1 of 3 "Gone": Pip finds the key is gone.\nPart 2 of 3 "Clue": Bramble has a clue.');
  });

  it('ties pictured characters to their reference pictures and describes the rest', () => {
    const request = episodeRequest(story, story.episodes[1], true);
    expect(request.references).toEqual(['pip.jpg']);
    expect(request.prompt).toContain('Pip is the character from <IMAGE_0> (small white rabbit, red scarf).');
    expect(request.prompt).toContain('Bramble: grumpy badger.');
    expect(request.prompt).toContain('Look: soft pastel 3D animation.');
    expect(request.prompt.endsWith('Pip meets Bramble by the river.')).toBe(true);
    const words = episodeRequest(story, story.episodes[1], false);
    expect(words.references).toEqual([]);
    expect(words.prompt).toContain('Pip: small white rabbit, red scarf.');
  });

  it('sends only the characters in the episode, at most the source limit', () => {
    expect(castOf(story, story.episodes[0]).map((item) => item.name)).toEqual(['Pip']);
    const crowd = { ...story, characters: Array.from({ length: 9 }, (_, index) => ({ id: `c${index}`, name: `C${index}`, description: '', imageFile: `${index}.jpg` })) };
    expect(episodeRequest(crowd, { ...story.episodes[2], videoPrompt: 'Everyone dances.' }, true).references).toHaveLength(MAX_REFERENCES);
  });

  it('keeps parts in order on each social', () => {
    const ws = workspace([clip(1, ['tiktok']), clip(2), clip(3)]);
    expect(earlierPartMissing(ws, clip(2), 'tiktok')).toBeNull();
    expect(earlierPartMissing(ws, clip(2), 'instagram')).toBe(1);
    expect(earlierPartMissing(ws, clip(3), 'tiktok')).toBe(2);
    expect(waitingOnEarlierPart(ws, clip(2), 'instagram')).toBe('Post Part 1 of 3 of The Lost Key on Instagram first, so the story goes up in order.');
    expect(waitingOnEarlierPart(ws, { ...clip(1), seriesId: undefined, episode: undefined }, 'instagram')).toBeNull();
    expect(nextToPost(ws, story, ['tiktok', 'instagram'])).toEqual([{ platform: 'tiktok', number: 2 }, { platform: 'instagram', number: 1 }]);
    expect(videoPartLabel(ws, clip(2))).toBe('Part 2 of 3');
  });

  it('uses the newest try of an episode that did not fail', () => {
    const failed = clip(1, [], { createdAt: 5, generation: { sourceId: 'g', sourceName: 'Grok', provider: 'grok', taskId: 't', prompt: 'p', status: 'failed' } });
    const ws = workspace([clip(1), failed]);
    expect(episodeVideo(ws, story, 1)?.id).toBe('v1');
    expect(episodeVideo(workspace([failed]), story, 1)?.id).toBe('v15');
  });

  it('counts progress and unlinks videos when a series is deleted', () => {
    const ws = workspace([clip(1, ['tiktok']), clip(2)]);
    expect(seriesProgress(ws, story, ['tiktok'])).toEqual({ total: 3, scripted: 1, made: 2, posted: 1 });
    const gone = withoutSeries(ws, 's');
    expect(gone.series).toEqual([]);
    expect(gone.videos?.every((video) => !video.seriesId && !video.episode)).toBe(true);
    expect(replaceEpisode(story, { ...story.episodes[1], script: 'new' }).episodes[1].script).toBe('new');
  });
});

describe('series writer (Grok)', () => {
  it('reads JSON from a fenced reply', () => {
    expect(parseJson('Sure!\n```json\n{"title":"x"}\n```')).toEqual({ title: 'x' });
    expect(() => parseJson('no story')).toThrow('Grok did not send back a story');
    expect(() => parseJson('{oops}')).toThrow('could not be read');
  });

  it('checks the plan and keeps exactly the asked number of parts', () => {
    const plan = readPlan({ title: 'T', bible: 'B', story: 'Once there was a rabbit.', style: 'S', characters: [{ name: 'Pip', description: 'rabbit' }, { description: 'nameless' }], episodes: [1, 2, 3, 4, 5].map((n) => ({ title: `E${n}`, summary: `S${n}` })) }, 4);
    expect(plan.episodes.map((item) => item.title)).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(plan.characters).toEqual([{ name: 'Pip', description: 'rabbit' }]);
    expect(plan.story).toBe('Once there was a rabbit.');
    expect(() => readPlan({ title: 'T', bible: 'B', episodes: [{ summary: 'a' }, { summary: 'b' }] }, 2)).toThrow('incomplete');
    expect(() => readPlan({ title: 'T', episodes: [] }, 4)).toThrow('incomplete');
    expect(() => readEpisode({ script: 'x' })).toThrow('incomplete');
    expect(readEpisode({ script: ' a ', videoPrompt: 'b', caption: 'c' })).toEqual({ script: 'a', videoPrompt: 'b', caption: 'c' });
  });

  it('asks for the arc with the brand, premise and part count', () => {
    const [, user] = planMessages({ brandName: 'Mia', brandNotes: 'calm massage tips', premise: 'A rabbit loses a key', episodes: 30, seconds: 10 });
    expect(user.content).toContain('12-part video series for the brand "Mia"');
    expect(user.content).toContain('calm massage tips');
    expect(user.content).toContain('exactly 12 parts');
  });

  it('writes a later part from the bible, the cast and a recap, and ends the last part', () => {
    const second = episodeMessages(story, story.episodes[1])[1].content;
    expect(second).toContain('Story bible: Pip the rabbit searches the meadow.');
    expect(second).toContain('- Bramble: grumpy badger');
    expect(second).toContain('Story so far:\nPart 1 of 3 "Gone"');
    expect(second).toContain('The next part will be: Pip finds it.');
    expect(second).toContain('one-line recap');
    const last = episodeMessages(story, story.episodes[2])[1].content;
    expect(last).toContain('This is the final part');
    expect(episodeMessages(story, story.episodes[0])[1].content).toContain('This is the first part.');
  });

  it('draws characters as fictional reference sheets', () => {
    expect(characterPicturePrompt(story, story.characters[0])).toMatch(/^Character reference sheet of a fictional character named Pip: small white rabbit, red scarf, in this look: soft pastel 3D animation, full figure/);
  });
});
