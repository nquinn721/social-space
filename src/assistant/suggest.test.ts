import { describe, expect, it } from 'vitest';
import { parseSuggestion } from './suggest';

describe('profile suggestions', () => {
  it('reads JSON even inside code fences and cleans the username', () => {
    expect(parseSuggestion('Sure!\n```json\n{"name":"Flutter Finds","username":"@flutter finds!","displayName":"Flutter","description":"Tiny wings."}\n```'))
      .toEqual({ name: 'Flutter Finds', username: 'flutterfinds', displayName: 'Flutter', description: 'Tiny wings.' });
  });
  it('rejects replies without a name and description', () => {
    expect(parseSuggestion('no json here')).toBeNull();
    expect(parseSuggestion('{"name":"Only name"}')).toBeNull();
  });
});

describe('naming prompt', () => {
  it('teaches the model what a good account looks like, with an example within the limit', async () => {
    const { NAMING_PROMPT } = await import('./suggest');
    expect(NAMING_PROMPT).toMatch(/call to action/);
    const example = NAMING_PROMPT.slice(NAMING_PROMPT.lastIndexOf('{'));
    expect(parseSuggestion(example)?.description.length).toBeLessThanOrEqual(80);
  });
});
