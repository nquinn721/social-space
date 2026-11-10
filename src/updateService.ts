import { invoke, isTauri } from '@tauri-apps/api/core';

/** A build of main that finished and is waiting to be installed. */
export type PreparedUpdate = { commit: string; installer: string; sha256: string; builtAt: number };
export type UpdateStatus = {
  /** available: main has changes this build lacks. ready: they are built and waiting to install. */
  state: 'available' | 'ready' | 'up_to_date';
  runningVersion: string;
  /** Version in main's tauri.conf.json, when it could be read. */
  latestVersion: string | null;
  sourceDir: string;
  prepared: PreparedUpdate | null;
  installedCommit: string;
  latestCommit: string | null;
  updateAvailable: boolean;
  newCommits: string[];
  blockedReason: string | null;
};
export type UpdateProgress = {
  state: 'idle' | 'running' | 'ready' | 'restarting' | 'failed';
  step: number;
  totalSteps: number;
  label: string;
  detail: string;
  error: string | null;
};
export type UpdateResult = { fromCommit: string; toCommit: string; succeeded: boolean };
/** managedBy is "Ava" while the Ava hub manages updates (its marker file or --hub); null when the app updates itself. */
export type UpdateManagement = { managedBy: string | null };

const COMMIT = /^[a-f0-9]{40}$/i;

/** Who manages updates. Outside the desktop app nothing does. */
export async function updateManagement(): Promise<UpdateManagement> {
  if (!isTauri()) return { managedBy: null };
  return invoke('update_management');
}
/** Returns null outside the desktop app, where there is nothing to update. */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  if (!isTauri()) return null;
  return invoke('check_for_update');
}
/** Builds the reviewed main commit in the background; follow it with updateProgress. Nothing is installed yet. */
export async function prepareUpdate(expectedCommit: string): Promise<void> {
  if (!isTauri()) throw new Error('Open the desktop app to install updates.');
  if (!COMMIT.test(expectedCommit)) throw new Error('The update commit could not be verified.');
  return invoke('prepare_update', { expectedCommit });
}
/** Installs the prepared build. The app closes, installs silently and starts again. */
export async function installPreparedUpdate(): Promise<void> {
  if (!isTauri()) throw new Error('Open the desktop app to install updates.');
  return invoke('install_prepared_update');
}
/** Restarts the app without installing anything. */
export async function restartApp(): Promise<void> {
  if (!isTauri()) return;
  return invoke('restart_app');
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
