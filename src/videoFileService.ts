import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';

const DESKTOP_ONLY = 'Open the desktop app to watch videos saved on this PC.';
function desktopOnly() { if (!isTauri()) throw new Error(DESKTOP_ONLY); }

/** True for a video saved on this PC (not a web link). */
export function isLocalVideo(path: string) { return /^[a-z]:[\/]|^\\/i.test(path.trim()); }
/** Lets the app play a video file from this PC and returns a URL for a <video> element. */
export async function videoPreviewUrl(path: string): Promise<string> { desktopOnly(); return convertFileSrc(await invoke<string>('preview_video_file', { path })); }
/** Opens the video in the PC's default player. */
export async function openVideoFile(path: string): Promise<void> { desktopOnly(); return invoke('open_video_file', { path, reveal: false }); }
/** Shows the video selected in File Explorer. */
export async function showVideoInFolder(path: string): Promise<void> { desktopOnly(); return invoke('open_video_file', { path, reveal: true }); }
