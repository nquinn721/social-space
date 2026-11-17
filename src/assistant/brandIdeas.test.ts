import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chat, loadSettings } from './grokClient';
import { parseBrandIdeas, suggestBrandIdeas } from './brandIdeas';

vi.mock('./grokClient', () => ({ chat: vi.fn(), loadSettings: vi.fn(() => ({ model: 'test-model' })) }));

const choices = ['Cozy home bakery', 'Mobile chair massage', 'Small-space gardening', 'Beginner watercolor lessons', 'Weekend hiking guides'];

describe('brand ideas', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('generates five choices even without an existing idea', async () => {
    vi.mocked(chat).mockResolvedValue({ role: 'assistant', content: JSON.stringify(choices) });
    await expect(suggestBrandIdeas()).resolves.toEqual(choices);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chat).mock.calls[0][1][1].content).toContain('exactly 5');
  });

  it('replaces one idea while telling the model to avoid the current choices', async () => {
    vi.mocked(chat).mockResolvedValue({ role: 'assistant', content: '```json\n["A massage practice for runners"]\n```' });
    await expect(suggestBrandIdeas({ count: 1, context: 'Massage for active adults', exclude: choices })).resolves.toEqual(['A massage practice for runners']);
    const prompt = vi.mocked(chat).mock.calls[0][1][1].content;
    expect(prompt).toContain('Massage for active adults');
    expect(prompt).toContain('Cozy home bakery');
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('handles a code-fenced array and rejects malformed or non-string output', () => {
    expect(parseBrandIdeas('Here are ideas:\n```json\n[" First ", "Second"]\n```')).toEqual(['First', 'Second']);
    expect(parseBrandIdeas('["Valid", 42]')).toBeNull();
    expect(parseBrandIdeas('not a JSON list')).toBeNull();
    expect(parseBrandIdeas('["unfinished"')).toBeNull();
  });

  it('rejects blank, duplicate, oversized and previously shown ideas without charging for a retry', async () => {
    for (const result of [
      ['one', 'ONE', 'three', 'four', 'five'],
      ['one', '', 'three', 'four', 'five'],
      ['one', 'two', 'three', 'four', 'x'.repeat(501)],
      ['one', 'two', 'three', 'four'],
    ]) {
      vi.mocked(chat).mockResolvedValueOnce({ role: 'assistant', content: JSON.stringify(result) });
      await expect(suggestBrandIdeas()).rejects.toThrow('distinct, usable ideas');
    }
    vi.mocked(chat).mockResolvedValueOnce({ role: 'assistant', content: '["MOBILE CHAIR MASSAGE"]' });
    await expect(suggestBrandIdeas({ count: 1, exclude: choices })).rejects.toThrow('distinct, usable ideas');
    expect(chat).toHaveBeenCalledTimes(5);
  });

  it('passes provider errors through and rejects invalid requests before calling it', async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error('Add an xAI key first.'));
    await expect(suggestBrandIdeas()).rejects.toThrow('Add an xAI key first.');
    await expect(suggestBrandIdeas({ count: 0 })).rejects.toThrow('between one and five');
    await expect(suggestBrandIdeas({ context: 'x'.repeat(501) })).rejects.toThrow('too long');
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
