import { describe, expect, it } from 'vitest';
import type { TextOverlay } from './model';
import { newOverlay, overlayFrame, overlayProblems, recordingFormat, scenesFromDifferences, textBeats, wrapText } from './textOverlays';

const base: TextOverlay = { id: 'a', text: 'Hop into the day', start: 1, end: 4, animation: 'fade', position: 'middle', size: 'medium', style: 'outline' };

describe('overlayFrame', () => {
  it('hides text outside its time and when empty', () => {
    expect(overlayFrame(base, 0.9)).toBeNull();
    expect(overlayFrame(base, 4)).toBeNull();
    expect(overlayFrame({ ...base, text: '  ' }, 2)).toBeNull();
  });
  it('fades in, holds and fades out', () => {
    expect(overlayFrame(base, 1)!.alpha).toBe(0);
    expect(overlayFrame(base, 2.5)!.alpha).toBe(1);
    expect(overlayFrame(base, 3.9)!.alpha).toBeLessThan(0.5);
  });
  it('pops from small to full size', () => {
    const pop = { ...base, animation: 'pop' as const };
    expect(overlayFrame(pop, 1)!.scale).toBeCloseTo(0.6);
    expect(overlayFrame(pop, 2.5)!.scale).toBeCloseTo(1);
  });
  it('slides up into place', () => {
    const slide = { ...base, animation: 'slide' as const };
    expect(overlayFrame(slide, 1.05)!.offsetY).toBeGreaterThan(0.02);
    expect(overlayFrame(slide, 2.5)!.offsetY).toBe(0);
  });
  it('types the letters out', () => {
    const typed = { ...base, animation: 'typewriter' as const };
    expect(overlayFrame(typed, 1.1)!.chars).toBeLessThan(base.text.length);
    expect(overlayFrame(typed, 3)!.chars).toBe(base.text.length);
  });
});

it('wraps text to the width and keeps line breaks', () => {
  const ctx = { measureText: (text: string) => ({ width: text.length * 10 }) };
  expect(wrapText(ctx, 'one two three four', 90)).toEqual(['one two', 'three', 'four']);
  expect(wrapText(ctx, 'a\nb', 90)).toEqual(['a', 'b']);
});

it('finds cuts where frames change a lot', () => {
  const differences = [2, 3, 2, 2, 60, 2, 3, 2, 2, 2, 2, 2, 2, 2, 2];
  expect(scenesFromDifferences(differences, 0.25, 4)).toEqual([[0, 1.3], [1.3, 4]]);
  expect(scenesFromDifferences(differences.map(() => 3), 0.25, 4)).toEqual([[0, 4]]);
  expect(scenesFromDifferences([], 0.25, 2)).toEqual([[0, 2]]);
});

it('splits long scenes into beats of about three seconds', () => {
  expect(textBeats([[0, 8]])).toEqual([[0, 2.7], [2.7, 5.3], [5.3, 8]]);
  expect(textBeats([[0, 2], [2, 5]])).toEqual([[0, 2], [2, 5]]);
});

it('starts a new text at the playhead, inside the video', () => {
  const made = newOverlay(7.9, 8);
  expect(made.start).toBe(7.5);
  expect(made.end).toBe(8);
  expect(newOverlay(1.23, 8).end).toBe(3.7);
});

it('says what stops saving', () => {
  expect(overlayProblems([], 8)).toEqual(['Add some text first.']);
  expect(overlayProblems([{ ...base, start: 5, end: 4 }], 8)).toEqual(['Text 1 ends before it starts.']);
  expect(overlayProblems([base], 8)).toEqual([]);
});

it('records MP4 when it can, then WebM', () => {
  expect(recordingFormat((type) => type.startsWith('video/mp4'))?.ext).toBe('mp4');
  expect(recordingFormat((type) => type === 'video/webm')?.ext).toBe('webm');
  expect(recordingFormat(() => false)).toBeNull();
});
