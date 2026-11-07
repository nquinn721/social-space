import type { Platform } from './model';

/** A locally saved reference; adding it does not create or connect a platform channel. */
export type Channel = {
  id: string;
  platform: Platform;
  name: string;
  handle: string;
  accountId: string | null;
  notes: string;
};

export function makeChannel(platform: Platform, name: string, handle: string, accountId: string | null, notes: string): Channel {
  return { id: crypto.randomUUID(), platform, name: name.trim(), handle: handle.trim().replace(/^@+/, ''), accountId, notes: notes.trim() };
}
