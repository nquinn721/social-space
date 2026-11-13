import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Platform } from './model';

/** One video going up on one social through its own upload page, in an app window. */
export type PostRequest = {
  platform: Platform; brandId: string; videoId: string; accountId?: string; handle: string; email: string;
  videoPath: string; title: string; text: string; madeWithAi: boolean; madeForKids: boolean; cover: string; coverMs?: number;
};
/** posted: the page showed the post went up. closed: the window was closed (posted says whether it had). */
export type PostingUpdate = { videoId: string; platform: Platform; state: 'posted' | 'closed'; posted: boolean };

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to post.'); }
export async function openPostingWindow(request: PostRequest): Promise<string> { desktopOnly(); return invoke('open_posting_window', { request }); }
/** Hears about posting windows; returns the function that stops listening. */
export async function onPostingUpdate(handler: (update: PostingUpdate) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  try { return await listen<PostingUpdate>('posting-window', (event) => handler(event.payload)); }
  catch { return () => {}; }
}
