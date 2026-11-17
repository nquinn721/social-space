import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginAttempt, clearAttempt, readAttempt, recordPublished } from './publishAttempt';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('Meta posting attempts', () => {
  it('keeps unfinished attempts across reloads and blocks a second request', () => {
    beginAttempt('video', 'instagram');
    expect(readAttempt('video', 'instagram')).toEqual({ state: 'pending' });
    expect(() => beginAttempt('video', 'instagram')).toThrow('needs review');
    expect(readAttempt('video', 'facebook')).toBeNull();
    recordPublished('video', 'instagram', 'https://www.instagram.com/reel/abc/');
    expect(readAttempt('video', 'instagram')).toEqual({ state: 'posted', link: 'https://www.instagram.com/reel/abc/' });
    clearAttempt('video', 'instagram');
    expect(readAttempt('video', 'instagram')).toBeNull();
  });
  it('refuses to start if the safety marker cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => beginAttempt('video', 'facebook')).toThrow('storage unavailable');
  });
  it('treats damaged markers as unresolved rather than permitting a duplicate', () => {
    localStorage.setItem('socialspace-publish-attempt-v1:instagram:video', 'invalid');
    expect(readAttempt('video', 'instagram')).toEqual({ state: 'pending' });
    expect(() => beginAttempt('video', 'instagram')).toThrow('needs review');
  });
});
