import { invoke, isTauri } from '@tauri-apps/api/core';

export type UpdateStatus = {
  installedCommit: string;
  latestCommit: string | null;
  updateAvailable: boolean;
  newCommits: string[];
  blockedReason: string | null;
};

/** Returns null outside the desktop app, where there is nothing to update. */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  if (!isTauri()) return null;
  return invoke('check_for_update');
}
export async function installUpdate(): Promise<void> {
  if (!isTauri()) throw new Error('Open the desktop app to install updates.');
  return invoke('install_update');
}
