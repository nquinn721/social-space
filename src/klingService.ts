import { invoke, isTauri } from '@tauri-apps/api/core';

export type KlingTask = { id: string; status: string; message: string | null; videoUrl: string | null };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use Kling API.'); }
export async function klingKeyStatus(): Promise<boolean> { desktopOnly(); return invoke('kling_key_status'); }
export async function saveKlingKey(key: string): Promise<void> { desktopOnly(); return invoke('save_kling_key', { key }); }
export async function removeKlingKey(): Promise<void> { desktopOnly(); return invoke('remove_kling_key'); }
export async function generateKlingVideo(prompt: string, aspectRatio: string, duration: number): Promise<KlingTask> { desktopOnly(); return invoke('generate_kling_video', { prompt, aspectRatio, duration }); }
export async function getKlingVideo(taskId: string): Promise<KlingTask> { desktopOnly(); return invoke('get_kling_video', { taskId }); }
export async function openKlingDeveloper(): Promise<void> { desktopOnly(); return invoke('open_kling_developer'); }

export async function openKlingVideo(taskId: string): Promise<void> { desktopOnly(); return invoke('open_kling_video', { taskId }); }


