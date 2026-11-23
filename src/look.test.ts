import { afterEach, describe, expect, it } from 'vitest';
import { applyMotion, applyStoredLook, applyTheme, celebrate, isCelebration, motionAllowed, storedMotion, storedTheme } from './look';

afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.motion; document.querySelectorAll('.confetti-canvas').forEach((node) => node.remove()); });

describe('look', () => {
  it('defaults to Neon with animations on', () => {
    expect(storedTheme()).toBe('neon');
    expect(storedMotion()).toBe('fun');
  });
  it('remembers the theme and animations choice and applies them on start', () => {
    applyTheme('sunset'); applyMotion('calm');
    delete document.documentElement.dataset.theme; delete document.documentElement.dataset.motion;
    applyStoredLook();
    expect(document.documentElement.dataset.theme).toBe('sunset');
    expect(document.documentElement.dataset.motion).toBe('calm');
  });
  it('ignores an unknown saved theme', () => {
    localStorage.setItem('socialspace-theme', 'nope');
    expect(storedTheme()).toBe('neon');
  });
  it('celebrates posts and launches, not removals or undo', () => {
    expect(isCelebration('Marked "Bunny hop" as posted on TikTok.')).toBe(true);
    expect(isCelebration('Scheduled 3 posts for Animals.')).toBe(true);
    expect(isCelebration('Marked Animals on TikTok as live. Check the username and add its password.')).toBe(true);
    expect(isCelebration('Marked "Bunny hop" as not posted on Instagram.')).toBe(false);
    expect(isCelebration('Removed Animals from Social Space.')).toBe(false);
    expect(isCelebration('Workspace settings saved.')).toBe(false);
  });
  it('adds no confetti when animations are off', () => {
    applyMotion('calm');
    expect(motionAllowed()).toBe(false);
    celebrate();
    expect(document.querySelector('.confetti-canvas')).toBeNull();
  });
});
