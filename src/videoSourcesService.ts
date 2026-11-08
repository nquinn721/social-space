import { invoke, isTauri } from '@tauri-apps/api/core';

export type VideoProvider = 'kling';
export type SourceStatus = 'unchecked' | 'verified' | 'rejected';
export type VideoSource = { id: string; name: string; provider: VideoProvider; status: SourceStatus; checkedAt: number | null; creditsRemaining: number | null; detail: string | null };

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to manage video sources.'); }
export async function listVideoSources(): Promise<VideoSource[]> { desktopOnly(); return invoke('list_video_sources'); }
export async function addVideoSource(name: string, provider: VideoProvider, key: string): Promise<VideoSource> { desktopOnly(); return invoke('add_video_source', { name, provider, key }); }
export async function checkVideoSource(id: string): Promise<VideoSource> { desktopOnly(); return invoke('check_video_source', { id }); }
export async function renameVideoSource(id: string, name: string): Promise<VideoSource> { desktopOnly(); return invoke('rename_video_source', { id, name }); }
export async function removeVideoSource(id: string): Promise<void> { desktopOnly(); return invoke('remove_video_source', { id }); }
export async function openProviderKeys(provider: VideoProvider): Promise<void> { desktopOnly(); return invoke('open_video_provider_keys', { provider }); }
