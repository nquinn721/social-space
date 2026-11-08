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
