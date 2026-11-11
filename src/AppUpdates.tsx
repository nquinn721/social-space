import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, RefreshCw, RotateCw, X as Close } from 'lucide-react';
import { checkForUpdate, installPreparedUpdate, prepareUpdate, restartApp, takeUpdateResult, updateProgress, type UpdateProgress, type UpdateResult, type UpdateStatus } from './updateService';
import { PageHeader } from './ui';
import './updates.css';

/** Checking is a git fetch in the source folder, so new merges to main show up within minutes. */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const PROGRESS_POLL_MS = 1000;
const short = (commit: string | null | undefined) => (commit && commit !== 'unknown' ? commit.slice(0, 7) : 'unknown');
const errorText = (error: unknown) => (typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong.');
const isActive = (progress: UpdateProgress | null) => progress?.state === 'running' || progress?.state === 'restarting';
const changeCount = (status: UpdateStatus) => {
  const count = status.newCommits.length;
  return count ? `${count}${count >= 20 ? '+' : ''} new change${count === 1 ? '' : 's'}` : 'New changes';
};

/** True when main has changes this build lacks and nothing blocks updating. */
export function hasUpdate(status: UpdateStatus | null): boolean {
  return (status?.state === 'available' || status?.state === 'ready') && !status.blockedReason;
}

export type AppUpdates = {
  status: UpdateStatus | null;
  progress: UpdateProgress | null;
  checking: boolean;
  error: string;
  check: (quiet?: boolean) => Promise<void>;
  followProgress: () => Promise<void>;
  /** Builds the newest main now; it also starts on its own when main has changes. */
  buildNow: () => Promise<void>;
  /** Installs the built update over the current version and restarts. */
  restartToUpdate: () => Promise<void>;
};

/**
 * Checks main at startup and every few minutes. When main has new commits it builds them in the
 * background on its own (once per commit, so a failed build is not retried in a loop), and the
 * app then offers one "Restart to update" that installs over the old version.
 */
export function useAppUpdates(intervalMs = CHECK_INTERVAL_MS): AppUpdates {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const checkingRef = useRef(false);
  const pollTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const progressRef = useRef<UpdateProgress | null>(null);
  const [progressLoaded, setProgressLoaded] = useState(false);
  const autoBuilt = useRef<string | null>(null);
  const acting = useRef(false);

  const check = useCallback(async (quiet = false) => {
    if (checkingRef.current) return;
    checkingRef.current = true; setChecking(true);
    if (!quiet) setError('');
    try { setStatus(await checkForUpdate()); setError(''); }
    catch (reason) { if (!quiet) setError(errorText(reason)); }
    finally { checkingRef.current = false; setChecking(false); }
  }, []);

  const followProgress = useCallback(async () => {
    window.clearTimeout(pollTimer.current);
    let next: UpdateProgress | null = null;
    try { next = await updateProgress(); } catch { return; }
    if (!mounted.current) return;
    // A build that just finished changes the status from available to ready.
    if (progressRef.current?.state === 'running' && next?.state === 'ready') void check(true);
    progressRef.current = next;
    setProgress(next); setProgressLoaded(true);
    if (isActive(next)) pollTimer.current = window.setTimeout(() => void followProgress(), PROGRESS_POLL_MS);
  }, [check]);

  useEffect(() => {
    mounted.current = true;
    void check(true);
    void followProgress();
    const timer = window.setInterval(() => void check(true), intervalMs);
    return () => { mounted.current = false; window.clearInterval(timer); window.clearTimeout(pollTimer.current); };
  }, [check, followProgress, intervalMs]);

  const startBuild = useCallback(async (commit: string) => {
    if (acting.current) return;
    acting.current = true; setError('');
    try { await prepareUpdate(commit); await followProgress(); }
    catch (reason) { setError(errorText(reason)); }
    finally { acting.current = false; }
  }, [followProgress]);

  // Build new commits on main automatically, so an update is ready by the time anyone looks.
  const waiting = status?.state === 'available' && !status.blockedReason ? status.latestCommit : null;
  useEffect(() => {
    if (!waiting || !progressLoaded || isActive(progressRef.current) || autoBuilt.current === waiting) return;
    autoBuilt.current = waiting;
    void startBuild(waiting);
  }, [waiting, progressLoaded, startBuild]);

  const buildNow = useCallback(async () => { if (waiting) { autoBuilt.current = waiting; await startBuild(waiting); } }, [waiting, startBuild]);
  const restartToUpdate = useCallback(async () => {
    if (acting.current) return;
    acting.current = true; setError('');
    try { await installPreparedUpdate(); await followProgress(); }
    catch (reason) {
      setError(errorText(reason));
      // The built installer was refused (for example, a manual build replaced it). Check again so
      // the update reads as available and is rebuilt on its own instead of dead-ending.
      autoBuilt.current = null;
      void check(true);
    }
    finally { acting.current = false; }
  }, [followProgress, check]);

  return { status, progress, checking, error, check, followProgress, buildNow, restartToUpdate };
}

function ProgressView({ progress }: { progress: UpdateProgress }) {
  const restarting = progress.state === 'restarting';
  const step = Math.max(progress.step, 1);
  const percent = restarting ? 100 : Math.round(((step - 1) / progress.totalSteps) * 100 + 100 / progress.totalSteps / 2);
  return <div className="update-progress">
    <strong>{restarting ? 'Installing the update. SocialSpace will restart…' : `Building the update · Step ${step} of ${progress.totalSteps}: ${progress.label}…`}</strong>
    <div className="update-bar" role="progressbar" aria-label="Update progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }}/></div>
    {!restarting && progress.detail && <small>{progress.detail}</small>}
  </div>;
}

/** Shows how the last update went, once, after the app restarts into it. */
function useUpdateResult() {
  const [result, setResult] = useState<UpdateResult | null>(null);
  useEffect(() => { takeUpdateResult().then(setResult).catch(() => undefined); }, []);
  return [result, () => setResult(null)] as const;
}

/** Label for the sidebar entry: what the update is doing right now. */
export function updateNavLabel(updates: Pick<AppUpdates, 'status' | 'progress'>): string {
  if (updates.progress?.state === 'running') return 'Building update…';
  if (updates.status?.state === 'ready' && !updates.status.blockedReason) return 'Update ready';
  return 'Updates';
}

/** A slim notice at the top of every page: the outcome after a restart, or an update ready to install. */
export function UpdateBanner({ updates, onOpen }: { updates: AppUpdates; onOpen: () => void }) {
  const { status, progress, restartToUpdate } = updates;
  const [result, clearResult] = useUpdateResult();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (result) {
    return <div role="status" className={`update-banner ${result.succeeded ? 'done' : 'failed'}`}>
      {result.succeeded ? <CheckCircle2 size={17}/> : <Download size={17}/>}
      <span>{result.succeeded ? `SocialSpace is updated to ${short(result.toCommit)}.` : `The update to ${short(result.toCommit)} didn't install. You're still on ${short(result.fromCommit)}.`}</span>
      {!result.succeeded && <button className="outline-button small-button" onClick={onOpen}>Open Updates</button>}
      <button className="update-dismiss" onClick={clearResult} aria-label="Dismiss update"><Close size={16}/></button>
    </div>;
  }
  if (progress?.state === 'restarting') return <div role="status" className="update-banner"><Download size={17}/><ProgressView progress={progress}/></div>;
  if (progress?.state === 'failed') return <div role="alert" className="update-banner failed"><Download size={17}/><span>The update didn't build.</span><button className="outline-button small-button" onClick={onOpen}>See why</button></div>;
  // Building happens quietly; the sidebar shows it. The banner only asks once it is ready.
  if (status?.state !== 'ready' || status.blockedReason || dismissed === status.latestCommit) return null;
  return <div role="status" className="update-banner">
    <Download size={17}/>
    <span>{updates.error ? `The update didn't start: ${updates.error}` : `Update ready: ${changeCount(status).toLowerCase()} from main. Restart to install it.`}</span>
    <button className="primary-button small-button" onClick={() => void restartToUpdate()}>Restart to update</button>
    <button className="update-dismiss" onClick={() => setDismissed(status.latestCommit)} aria-label="Dismiss update"><Close size={16}/></button>
  </div>;
}

/** The Updates page: what is installed, what is new on main, and the build or install in progress. */
export function UpdatesPage({ updates }: { updates: AppUpdates }) {
  const { status, progress, checking, error, check, buildNow, restartToUpdate } = updates;
  const [restarting, setRestarting] = useState(false);
  const building = isActive(progress);
  const busy = checking || building || restarting;
  const ready = status?.state === 'ready' && !status.blockedReason;
  const failed = progress?.state === 'failed';

  async function restart() {
    if (restarting) return;
    setRestarting(true);
    try { await restartApp(); } finally { setRestarting(false); }
  }

  return <>
    <PageHeader eyebrow="Keep SocialSpace current" title="Updates" description="When something new lands on main, SocialSpace builds it in the background. Restart to update installs it over this version and opens the new one."/>
    <section className="settings-card update-panel" aria-labelledby="update-heading">
      <div className="update-heading"><h2 id="update-heading"><RotateCw size={17}/> Changes on main</h2><button type="button" className="icon-button" disabled={busy} onClick={() => void check()} aria-label="Check for updates" title="Check for updates"><RefreshCw size={16} className={checking ? 'spin' : undefined}/></button></div>
      {!status ? <p className="update-note">{checking ? 'Checking for updates…' : 'Update status is not available yet.'}</p> : <>
        <dl className="update-facts">
          <dt>Running</dt><dd>SocialSpace {status.runningVersion}, build {short(status.installedCommit)}</dd>
          <dt>Latest on main</dt><dd>{short(status.latestCommit)}</dd>
          <dt>Source folder</dt><dd>{status.sourceDir}</dd>
        </dl>
        {ready && status.prepared ? <p className="update-ready">Update ready: commit <strong>{short(status.prepared.commit)}</strong> is built. Restart to install it.</p>
          : status.state === 'available' && building ? <p className="update-ready">Building {changeCount(status).toLowerCase()} from main commit <strong>{short(status.latestCommit)}</strong> in the background.</p>
          : status.state === 'available' ? <p className="update-ready">{changeCount(status)} on main commit <strong>{short(status.latestCommit)}</strong>.</p>
          : <p className="update-note">SocialSpace is up to date with main.</p>}
        {status.updateAvailable && status.newCommits.length > 0 && <ul className="update-commits" aria-label="Changes in this update">{status.newCommits.map((commit) => <li key={commit}>{commit}</li>)}</ul>}
        {status.blockedReason && <p className="update-error">{status.blockedReason}</p>}
      </>}
      {building && progress && <ProgressView progress={progress}/>}
      {failed && <p className="update-error" role="alert">The update didn't build: {progress?.error}</p>}
      {error && <p className="update-error" role="alert">{error}</p>}
      <div className="update-actions">
        {ready ? <button type="button" className="primary-button" disabled={busy} onClick={() => void restartToUpdate()}><Download size={15}/> Restart to update</button>
          : status?.state === 'available' && !status.blockedReason && !building && <button type="button" className="primary-button" disabled={busy} onClick={() => void buildNow()}><Download size={15}/>{failed ? 'Try the build again' : 'Build now'}</button>}
        <button type="button" className="outline-button" disabled={busy} onClick={() => void restart()}><RotateCw size={15}/> Restart without updating</button>
      </div>
    </section>
  </>;
}
