import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Platform } from './model';
export type QueueMode = 'automatic' | 'manual';
export type QueueStatus = 'scheduled' | 'publishing' | 'posted' | 'manual_due' | 'needs_review';
export type QueueInput = { id: string; platform: Platform; channelId: string; channelName: string; channelHandle: string; mediaSource: string; caption: string; scheduledAt: number; mode: QueueMode };
export type QueueJob = QueueInput & { status: QueueStatus; error: string | null; instagramAccountId: string | null };
function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use the posting queue.'); }
export async function listQueue(): Promise<QueueJob[]> { desktopOnly(); return invoke('list_queue'); }
export async function addQueueJob(job: QueueInput): Promise<QueueJob> { desktopOnly(); return invoke('add_queue_job', { job }); }
export async function completeQueueJob(id: string): Promise<QueueJob> { desktopOnly(); return invoke('complete_queue_job', { id }); }
export async function deleteQueueJob(id: string): Promise<void> { desktopOnly(); return invoke('delete_queue_job', { id }); }
export async function chooseVideoFile(): Promise<string | null> { desktopOnly(); return invoke('choose_video_file'); }
