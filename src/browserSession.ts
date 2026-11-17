import { normalizeHandle, type Platform } from './model';
import type { BrandSignIn } from './postingService';

/** A cookie is a hint about a prior session, not proof that the intended account is still selected. */
export type BrowserSession = 'not-checked' | 'signed-out' | 'mismatch' | 'unverified' | 'matched';
export function browserSession(platform: Platform, expectedHandle: string, state?: BrandSignIn): BrowserSession {
  if (!state) return 'not-checked';
  if (!state.signedIn) return 'signed-out';
  const expected = normalizeHandle(expectedHandle).toLowerCase();
  const observed = normalizeHandle(state.handle ?? '').toLowerCase();
  // A Google session does not identify the currently selected YouTube channel.
  if (platform === 'youtube' || !observed || !expected) return 'unverified';
  return observed === expected ? 'matched' : 'mismatch';
}
