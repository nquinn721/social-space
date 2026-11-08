import { invoke, isTauri } from '@tauri-apps/api/core';

export type UpdateStatus = {
  installedCommit: string;
  latestCommit: string | null;
  updateAvailable: boolean;
  newCommits: string[];
  blockedReason: string | null;
};
export type UpdateProgress = {
  state: 'idle' | 'running' | 'restarting' | 'failed';
  step: number;
  totalSteps: number;
  label: string;
  detail: string;
  error: string | null;
};
export type UpdateResult = { fromCommit: string; toCommit: string; succeeded: boolean };

/** Returns null outside the desktop app, where there is nothing to update. */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  if (!isTauri()) return null;
  return invoke('check_for_update');
}
/** Starts the update in the background; follow it with updateProgress. */
export async function installUpdate(): Promise<void> {
  if (!isTauri()) throw new Error('Open the desktop app to install updates.');
  return invoke('install_update');
}
export async function updateProgress(): Promise<UpdateProgress | null> {
  if (!isTauri()) return null;
  return invoke('update_progress');
}
/** The outcome of the update that restarted the app, returned only once. */
export async function takeUpdateResult(): Promise<UpdateResult | null> {
  if (!isTauri()) return null;
  return invoke('take_update_result');
}
