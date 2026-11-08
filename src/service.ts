import { invoke, isTauri } from '@tauri-apps/api/core';
import { migrateWorkspace } from './brands';
import { EMPTY_WORKSPACE, type Platform, type PlatformAction, type Workspace } from './model';

const STORAGE_KEY = 'social-manager-workspace';
async function readSaved(): Promise<Partial<Workspace>> {
  if (isTauri()) return invoke('load_workspace');
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? JSON.parse(saved) as Partial<Workspace> : EMPTY_WORKSPACE;
}
/** Loads the workspace, moving older data onto brands and saving that once. */
export async function loadWorkspace(): Promise<Workspace> {
  const saved = await readSaved();
  const workspace = migrateWorkspace(saved);
  if (JSON.stringify(workspace.brands) !== JSON.stringify(saved.brands ?? []) || workspace.accounts.some((account, index) => account !== saved.accounts?.[index])) return saveWorkspace(workspace);
  return workspace;
}
/** Every save goes through the brand model, so an account added anywhere always has its brand. */
export async function saveWorkspace(next: Workspace): Promise<Workspace> {
  const workspace = migrateWorkspace(next);
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

