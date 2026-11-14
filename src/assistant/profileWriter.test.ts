import { describe, expect, it } from 'vitest';
import { cleanKeywords, parseKeywords, parseProfileCopy } from './profileWriter';
import { BIO_LIMITS } from '../model';

describe('profile copy from Grok', () => {
  it('keeps a bio per asked social, fitted to its limit, with no hashtags', () => {
    const long = 'Calm hands for busy people. '.repeat(10);
    const copy = parseProfileCopy(`Sure! {"bios": {"instagram": "Slow massage in Austin #relax", "tiktok": "${long}", "x": 7}, "keywords": ["#Massage", "relaxation", "massage"]}`, ['instagram', 'tiktok', 'x']);
    expect(copy?.bios.instagram).toBe('Slow massage in Austin');
    expect(copy?.bios.tiktok!.length).toBeLessThanOrEqual(BIO_LIMITS.tiktok);
    expect(copy?.bios.x).toBeUndefined();
    expect(copy?.keywords).toEqual(['massage', 'relaxation']);
  });

  it('ignores socials not asked for and replies without JSON', () => {
    expect(parseProfileCopy('{"bios": {"youtube": "hi"}}', ['instagram'])).toBeNull();
    expect(parseProfileCopy('no idea', ['instagram'])).toBeNull();
  });

  it('cleans keywords to what YouTube takes', () => {
    expect(parseKeywords(' Spa ,#calm,, spa, a very very very long keyword that goes on')).toEqual(['spa', 'calm']);
    const many = Array.from({ length: 40 }, (_, index) => `keyword number ${index}`);
    const kept = cleanKeywords(many);
    expect(kept.length).toBeLessThanOrEqual(15);
    expect(kept.join(', ').length).toBeLessThanOrEqual(500);
  });
});
