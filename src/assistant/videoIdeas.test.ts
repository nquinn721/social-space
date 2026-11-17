import { describe, expect, it } from 'vitest';
import { readVideoIdeas, videoIdeaMessages, type VideoIdeaRequest } from './videoIdeas';

const request: VideoIdeaRequest = { brand: 'Soft Wings', notes: 'calm rabbit videos', category: 'Rabbits', durations: [5, 8, 10, 15], count: 1 };
const idea = { title: 'A tiny garden', description: 'Two clips show the garden growing.', scenes: [{ prompt: 'A rabbit plants a seed in morning light.', seconds: 8 }, { prompt: 'A rabbit watches a flower bloom.', seconds: 10 }] };

describe('video prompt suggestions', () => {
  it('includes the brand, category and available lengths in the request', () => {
    expect(videoIdeaMessages(request)[1].content).toContain('calm rabbit videos');
    expect(videoIdeaMessages(request)[1].content).toContain('5, 8, 10, 15');
  });
  it('returns complete separate scene prompts and their supported durations', () => {
    expect(readVideoIdeas(JSON.stringify({ ideas: [idea] }), request)).toEqual([idea]);
    expect(() => readVideoIdeas(JSON.stringify({ ideas: [{ ...idea, scenes: [{ prompt: 'a', seconds: 60 }] }] }), request)).toThrow('unsupported clip length');
    expect(() => readVideoIdeas(JSON.stringify({ ideas: [idea] }), { ...request, exclude: [idea.title] })).toThrow('incomplete idea');
  });
});
