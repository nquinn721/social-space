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
};

/** Checks main at startup and every few minutes, and follows a running build until it finishes. */
export function useAppUpdates(intervalMs = CHECK_INTERVAL_MS): AppUpdates {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const checkingRef = useRef(false);
  const pollTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const progressRef = useRef<UpdateProgress | null>(null);

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
    setProgress(next);
    if (isActive(next)) pollTimer.current = window.setTimeout(() => void followProgress(), PROGRESS_POLL_MS);
  }, [check]);

  useEffect(() => {
    mounted.current = true;
    void check(true);
    void followProgress();
    const timer = window.setInterval(() => void check(true), intervalMs);
    return () => { mounted.current = false; window.clearInterval(timer); window.clearTimeout(pollTimer.current); };
  }, [check, followProgress, intervalMs]);

  return { status, progress, checking, error, check, followProgress };
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

/** A slim notice at the top of every page: the outcome after a restart, a running build, or an update waiting. */
export function UpdateBanner({ updates, onOpen }: { updates: AppUpdates; onOpen: () => void }) {
  const { status, progress } = updates;
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
  if (progress && isActive(progress)) return <div role="status" className="update-banner"><Download size={17}/><ProgressView progress={progress}/><button className="outline-button small-button" onClick={onOpen}>View</button></div>;
  if (progress?.state === 'failed') return <div role="alert" className="update-banner failed"><Download size={17}/><span>The update didn't finish.</span><button className="outline-button small-button" onClick={onOpen}>See why</button></div>;
  if (!status || !hasUpdate(status) || dismissed === status.latestCommit) return null;
  return <div role="status" className="update-banner">
    <Download size={17}/>
    <span>{status.state === 'ready' ? 'An update is built and ready to install.' : `${changeCount(status)} on main for SocialSpace.`}</span>
    <button className="primary-button small-button" onClick={onOpen}>{status.state === 'ready' ? 'Install update' : 'View update'}</button>
    <button className="update-dismiss" onClick={() => setDismissed(status.latestCommit)} aria-label="Dismiss update"><Close size={16}/></button>
  </div>;
}

/** The Updates page: what is installed, what is new on main, and the build then install-and-restart steps. */
export function UpdatesPage({ updates }: { updates: AppUpdates }) {
  const { status, progress, checking, error, check, followProgress } = updates;
  const [reviewingBuild, setReviewingBuild] = useState('');
  const [reviewingInstall, setReviewingInstall] = useState(false);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState('');
  const guard = useRef(false);
  const lastProgress = useRef(progress?.state);

  // When a build finishes while this page is open, ask to install it right away.
  useEffect(() => {
    if (lastProgress.current === 'running' && progress?.state === 'ready') setReviewingInstall(true);
    lastProgress.current = progress?.state;
  }, [progress?.state]);

  const building = isActive(progress);
  const busy = checking || starting || building;

  async function act(action: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true; setStarting(true); setActionError('');
    try { await action(); }
    catch (reason) { setActionError(errorText(reason)); }
    finally { guard.current = false; setStarting(false); }
  }
  const build = () => act(async () => { const commit = reviewingBuild; setReviewingBuild(''); setReviewingInstall(false); await prepareUpdate(commit); await followProgress(); });
  const install = () => act(async () => { await installPreparedUpdate(); setReviewingInstall(false); await followProgress(); });
  const restart = () => act(restartApp);
  function startUpdate() {
    setActionError('');
    if (status?.state === 'ready') setReviewingInstall(true);
    else if (status?.state === 'available' && status.latestCommit) setReviewingBuild(status.latestCommit);
  }

  const canUpdate = hasUpdate(status) && !busy;
  return <>
    <PageHeader eyebrow="Keep SocialSpace current" title="Updates" description="SocialSpace updates from the main branch: it builds the newest version on this PC, then installs it and restarts when you say so."/>
    <section className="settings-card update-panel" aria-labelledby="update-heading">
      <div className="update-heading"><h2 id="update-heading"><RotateCw size={17}/> Changes on main</h2><button type="button" className="icon-button" disabled={busy} onClick={() => void check()} aria-label="Check for updates" title="Check for updates"><RefreshCw size={16} className={checking ? 'spin' : undefined}/></button></div>
      {!status ? <p className="update-note">{checking ? 'Checking for updates…' : 'Update status is not available yet.'}</p> : <>
        <dl className="update-facts">
          <dt>Running</dt><dd>SocialSpace {status.runningVersion}, build {short(status.installedCommit)}</dd>
          <dt>Latest on main</dt><dd>{short(status.latestCommit)}</dd>
          <dt>Source folder</dt><dd>{status.sourceDir}</dd>
        </dl>
        {status.state === 'ready' && status.prepared ? <p className="update-ready">Update built from commit <strong>{short(status.prepared.commit)}</strong> and ready to install.</p>
          : status.state === 'available' ? <p className="update-ready">{changeCount(status)} available from main commit <strong>{short(status.latestCommit)}</strong>.</p>
          : <p className="update-note">SocialSpace is up to date with main.</p>}
        {status.updateAvailable && status.newCommits.length > 0 && <ul className="update-commits" aria-label="Changes in this update">{status.newCommits.map((commit) => <li key={commit}>{commit}</li>)}</ul>}
        {status.blockedReason && <p className="update-error">{status.blockedReason}</p>}
      </>}
      {building && progress && <ProgressView progress={progress}/>}
      {progress?.state === 'failed' && <p className="update-error" role="alert">The update didn't finish: {progress.error}</p>}
      {(actionError || error) && <p className="update-error" role="alert">{actionError || `Could not check for updates: ${error}`}</p>}
      <div className="update-actions">
        <button type="button" className="primary-button" disabled={!canUpdate} onClick={startUpdate}><Download size={15}/>{status?.state === 'ready' ? 'Install update' : 'Update SocialSpace'}</button>
        <button type="button" className="outline-button" disabled={busy} onClick={() => void restart()}><RotateCw size={15}/> Restart SocialSpace</button>
      </div>
      {reviewingBuild && status?.state === 'available' && status.latestCommit === reviewingBuild && <div className="update-review">
        <strong>Build the available update?</strong>
        <p>SocialSpace will get main commit {short(reviewingBuild)}, install its dependencies and build it on this PC in the background. You can keep working; it asks before installing and restarting.</p>
        <div className="update-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void build()}>Build update</button><button type="button" className="outline-button" disabled={busy} onClick={() => setReviewingBuild('')}>Cancel</button></div>
      </div>}
      {reviewingInstall && status?.state === 'ready' && status.prepared && <div className="update-review">
        <strong>Install this update?</strong>
        <p>Commit {short(status.prepared.commit)} will be installed. SocialSpace will close and restart; anything in progress, like a sign-up page, will stop.</p>
        <div className="update-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void install()}>Install and restart</button><button type="button" className="outline-button" disabled={busy} onClick={() => setReviewingInstall(false)}>Cancel</button></div>
      </div>}
      <p className="update-footnote">Restarting alone does not install an update.</p>
    </section>
  </>;
}
