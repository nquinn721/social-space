import type { Platform } from './model';

type ApiPlatform = Extract<Platform, 'instagram' | 'facebook'>;
type Attempt = { state: 'pending' | 'posted'; link?: string };
const PREFIX = 'socialspace-publish-attempt-v1:';
const key = (videoId: string, platform: ApiPlatform) => `${PREFIX}${platform}:${videoId}`;

/** A marker is written before sending: an interruption must not silently permit another post. */
export function readAttempt(videoId: string, platform: ApiPlatform): Attempt | null {
  let raw: string | null;
  try { raw = localStorage.getItem(key(videoId, platform)); }
  catch { return { state: 'pending' }; }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Attempt;
    if (value.state === 'posted') return { state: 'posted', link: typeof value.link === 'string' ? value.link : undefined };
  } catch { /* A damaged marker is still an unresolved attempt. */ }
  return { state: 'pending' };
}
export function beginAttempt(videoId: string, platform: ApiPlatform) {
  if (readAttempt(videoId, platform)) throw new Error('A previous posting attempt needs review before trying again.');
  localStorage.setItem(key(videoId, platform), JSON.stringify({ state: 'pending' } satisfies Attempt));
}
export function recordPublished(videoId: string, platform: ApiPlatform, link?: string) {
  localStorage.setItem(key(videoId, platform), JSON.stringify({ state: 'posted', link } satisfies Attempt));
}
export function clearAttempt(videoId: string, platform: ApiPlatform) {
  localStorage.removeItem(key(videoId, platform));
}
