import { invoke, isTauri } from '@tauri-apps/api/core';

export type VideoProvider = 'kling' | 'grok';
export type SourceStatus = 'unchecked' | 'verified' | 'rejected';
export type VideoSource = { id: string; name: string; provider: VideoProvider; status: SourceStatus; checkedAt: number | null; creditsRemaining: number | null; detail: string | null };
/** Every source, plus the one all video generation uses. */
export type SourcesState = { active: string | null; sources: VideoSource[] };
export type VideoTask = { id: string; status: string; message: string | null; videoUrl: string | null };
export type StartedVideo = VideoTask & { sourceId: string; sourceName: string; provider: VideoProvider };

export const DESKTOP_ONLY = 'Open the desktop app to manage video sources.';
function desktopOnly() { if (!isTauri()) throw new Error(DESKTOP_ONLY); }
export async function listVideoSources(): Promise<SourcesState> { desktopOnly(); return invoke('list_video_sources'); }
export async function setActiveVideoSource(id: string): Promise<SourcesState> { desktopOnly(); return invoke('set_active_video_source', { id }); }
export async function addVideoSource(name: string, provider: VideoProvider, key: string): Promise<VideoSource> { desktopOnly(); return invoke('add_video_source', { name, provider, key }); }
export async function checkVideoSource(id: string): Promise<VideoSource> { desktopOnly(); return invoke('check_video_source', { id }); }
export async function renameVideoSource(id: string, name: string): Promise<VideoSource> { desktopOnly(); return invoke('rename_video_source', { id, name }); }
export async function removeVideoSource(id: string): Promise<void> { desktopOnly(); return invoke('remove_video_source', { id }); }
export async function openProviderKeys(provider: VideoProvider): Promise<void> { desktopOnly(); return invoke('open_video_provider_keys', { provider }); }
export async function openProviderSite(provider: VideoProvider): Promise<void> { desktopOnly(); return invoke('open_video_provider_site', { provider }); }

/** Starts a video with the given source, or the active one when `sourceId` is null. */
export async function generateVideo(sourceId: string | null, prompt: string, aspectRatio: string, duration: number): Promise<StartedVideo> { desktopOnly(); return invoke('generate_video', { sourceId, prompt, aspectRatio, duration }); }
export async function getVideo(sourceId: string, taskId: string): Promise<VideoTask> { desktopOnly(); return invoke('get_video', { sourceId, taskId }); }
export async function openVideo(sourceId: string, taskId: string): Promise<void> { desktopOnly(); return invoke('open_video', { sourceId, taskId }); }
