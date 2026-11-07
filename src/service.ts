import { invoke, isTauri } from '@tauri-apps/api/core';
import { EMPTY_WORKSPACE, type Platform, type PlatformAction, type Workspace } from './model';

const STORAGE_KEY = 'social-manager-workspace';
export async function loadWorkspace(): Promise<Workspace> {
  if (isTauri()) return invoke('load_workspace');
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return EMPTY_WORKSPACE;
  const workspace = JSON.parse(saved) as Workspace;
  return { ...workspace, channels: workspace.channels ?? [] };
}
export async function saveWorkspace(workspace: Workspace): Promise<Workspace> {
  if (isTauri()) return invoke('save_workspace', { workspace });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  return workspace;
}
export async function openPlatformAction(platform: Platform, action: PlatformAction): Promise<void> {
  if (isTauri()) return invoke('open_platform_action', { platform, action });
  throw new Error('Open the desktop app to view this platform.');
}
export async function openKling(): Promise<void> {
  if (isTauri()) return invoke('open_kling');
  throw new Error('Open the desktop app to view Kling.');
}

