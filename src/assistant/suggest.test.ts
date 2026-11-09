import { describe, expect, it } from 'vitest';
import { fitDescription, parseSuggestion, PROFILE_GUIDE } from './suggest';

describe('profile suggestions', () => {
  it('reads JSON even inside code fences and cleans the username', () => {
    expect(parseSuggestion('Sure!\n```json\n{"name":"Flutter Finds","username":"@flutter finds!","displayName":"Flutter","description":"Tiny wings."}\n```'))
      .toEqual({ name: 'Flutter Finds', username: 'flutterfinds', displayName: 'Flutter', description: 'Tiny wings.', imagePrompt: '', imageStyle: 'photo' });
  });
  it('reads the picture idea and falls back to a photo for unknown styles', () => {
    expect(parseSuggestion('{"name":"A","description":"B","imagePrompt":"pastel butterfly mark","imageStyle":"Logo"}')).toMatchObject({ imagePrompt: 'pastel butterfly mark', imageStyle: 'logo' });
    expect(parseSuggestion('{"name":"A","description":"B","imageStyle":"3d render"}')?.imageStyle).toBe('photo');
  });
  it('trims an overlong description at a natural break', () => {
    expect(fitDescription('Fit moms, real life. 5-minute workouts.\nTap for your reset.', 40)).toBe('Fit moms, real life.\n5-minute workouts.');
    expect(fitDescription('One very long sentence without any break at all', 20)).toBe('One very long');
    expect(fitDescription('Short.', 20)).toBe('Short.');
  });
  it('gives the model craft rules and a worked example', () => {
    expect(PROFILE_GUIDE).toMatch(/hook/);
    expect(PROFILE_GUIDE).toMatch(/Never name or imitate a real or famous person/);
  });
  it('rejects replies without a name and description', () => {
    expect(parseSuggestion('no json here')).toBeNull();
    expect(parseSuggestion('{"name":"Only name"}')).toBeNull();
  });
});
