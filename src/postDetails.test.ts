import { describe, expect, it } from 'vitest';
import { detailProblems, detailsOf, madeInApp, parseHashtags, postText, startingPost, videoStage } from './postDetails';
import { parsePostSuggestion } from './assistant/postSuggest';
import type { Video } from './model';

const video: Video = { id: 'v', brandId: 'b', categoryId: 'c', title: 'Hop', mediaSource: 'C:\\a.mp4', caption: 'Hi', posted: [], createdAt: 1 };

describe('post details', () => {
  it('cleans hashtags', () => {
    expect(parseHashtags('#bunny, Cute  #bunny snow-day ##x')).toEqual(['bunny', 'Cute', 'snowday', 'x']);
  });
  it('puts hashtags after the description', () => {
    expect(postText({ ...video, details: { hashtags: ['a', 'b'], youtubeTitle: '', madeWithAi: false, shareToFeed: true, madeForKids: false } })).toBe('Hi\n\n#a #b');
  });
  it('starts from the category defaults only when the video has none of its own', () => {
    const category = { id: 'c', brandId: 'b', name: 'Bunny', defaults: { caption: 'Default', hashtags: ['bunny'] } };
    expect(startingPost({ ...video, caption: '' }, category)).toMatchObject({ caption: 'Default', details: { hashtags: ['bunny'] } });
    expect(startingPost(video, category).caption).toBe('Hi');
  });
  it('knows each stage', () => {
    expect(videoStage(video, ['instagram'])).toBe('review');
    expect(videoStage({ ...video, posted: ['instagram'] }, ['instagram'])).toBe('posted');
    expect(videoStage({ ...video, generation: { sourceId: 's', sourceName: 'K', provider: 'kling', taskId: 't', prompt: 'p', status: 'working' } }, ['instagram'])).toBe('making');
  });
  it('flags too many Instagram hashtags', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `t${i}`);
    expect(detailProblems({ ...video, details: { hashtags: tags, youtubeTitle: '', madeWithAi: false, shareToFeed: true, madeForKids: false } }, ['instagram'])[0]).toMatch('30 hashtags');
  });
  it('reads the assistant reply', () => {
    expect(parsePostSuggestion('```json\n{"description":"Snow day #bunny","hashtags":["#Bunny","snow"]}\n```')).toEqual({ description: 'Snow day', hashtags: ['Bunny', 'snow'] });
    expect(parsePostSuggestion('no json')).toBeNull();
  });
});

describe('AI labels', () => {
  const base: Video = { id: 'v', brandId: 'b', categoryId: 'c', title: 'T', mediaSource: 'a.mp4', caption: 'Hi', posted: [], createdAt: 1 };
  it('labels every video as AI-made by default', () => {
    expect(detailsOf(base).madeWithAi).toBe(true);
  });
  it('always labels videos the app made, even if saved unlabeled', () => {
    const off = { hashtags: [], youtubeTitle: '', madeWithAi: false, shareToFeed: true, madeForKids: false };
    expect(detailsOf({ ...base, details: off }).madeWithAi).toBe(false);
    for (const made of [{ prompt: 'a bunny' }, { seriesId: 's', episode: 1 }, { textEdit: { sourcePath: 'a.mp4', overlays: [] } }]) {
      expect(madeInApp({ ...base, ...made })).toBe(true);
      expect(detailsOf({ ...base, ...made, details: off }).madeWithAi).toBe(true);
    }
  });
  it('adds #AIgenerated on X, and where asked, but not where the social has its own label', () => {
    const video = { ...base, details: { hashtags: ['bunny'], youtubeTitle: '', madeWithAi: true, shareToFeed: true, madeForKids: false } };
    expect(postText(video, 'x')).toBe('Hi\n\n#bunny #AIgenerated');
    expect(postText(video, 'tiktok')).toBe('Hi\n\n#bunny');
    expect(postText(video, undefined, true)).toBe('Hi\n\n#bunny #AIgenerated');
    expect(postText({ ...video, details: { ...video.details, hashtags: ['aigenerated'] } }, 'x')).toBe('Hi\n\n#aigenerated');
    expect(postText({ ...video, details: { ...video.details, madeWithAi: false } }, 'x')).toBe('Hi\n\n#bunny');
  });
});
