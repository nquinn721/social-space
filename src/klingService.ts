import { invoke, isTauri } from '@tauri-apps/api/core';

export type KlingTask = { id: string; status: string; message: string | null; videoUrl: string | null };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use Kling API.'); }
export async function generateKlingVideo(sourceId: string, prompt: string, aspectRatio: string, duration: number): Promise<KlingTask> { desktopOnly(); return invoke('generate_kling_video', { sourceId, prompt, aspectRatio, duration }); }
export async function getKlingVideo(sourceId: string, taskId: string): Promise<KlingTask> { desktopOnly(); return invoke('get_kling_video', { sourceId, taskId }); }
export async function openKlingVideo(sourceId: string, taskId: string): Promise<void> { desktopOnly(); return invoke('open_kling_video', { sourceId, taskId }); }
