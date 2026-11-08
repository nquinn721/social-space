import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, RefreshCw, X as Close } from 'lucide-react';
import { checkForUpdate, installUpdate, takeUpdateResult, updateProgress, type UpdateProgress, type UpdateResult, type UpdateStatus } from './updateService';
import './updates.css';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const PROGRESS_POLL_MS = 1000;
const short = (commit: string | null) => (commit && commit !== 'unknown' ? commit.slice(0, 7) : 'unknown');
const errorText = (error: unknown) => (typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong.');
const commitCount = (status: UpdateStatus) => {
  const count = status.newCommits.length;
  return count ? `${count}${count >= 20 ? '+' : ''} new change${count === 1 ? '' : 's'}` : 'New changes';
};

// One progress feed shared by the banner and the settings card, polled only while an update runs.
let currentProgress: UpdateProgress | null = null;
const listeners = new Set<(progress: UpdateProgress | null) => void>();
let pollTimer: number | undefined;
const isActive = (progress: UpdateProgress | null) => progress?.state === 'running' || progress?.state === 'restarting';
async function refreshProgress() {
  window.clearTimeout(pollTimer);
  try { currentProgress = await updateProgress(); } catch { /* keep the last known state */ }
  listeners.forEach((listener) => listener(currentProgress));
  if (isActive(currentProgress) && listeners.size) pollTimer = window.setTimeout(() => void refreshProgress(), PROGRESS_POLL_MS);
}
function useUpdateProgress() {
  const [progress, setProgress] = useState(currentProgress);
  useEffect(() => {
    listeners.add(setProgress);
    void refreshProgress();
    return () => { listeners.delete(setProgress); if (!listeners.size) window.clearTimeout(pollTimer); };
  }, []);
  return progress;
}

function useAppUpdate(autoCheck: boolean) {
  const progress = useUpdateProgress();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async (quiet: boolean) => {
    setChecking(true);
    if (!quiet) setError('');
    try { setStatus(await checkForUpdate()); }
    catch (reason) { if (!quiet) setError(errorText(reason)); }
    finally { setChecking(false); }
  }, []);
  const install = useCallback(async () => {
    setInstalling(true); setError('');
    try { await installUpdate(); await refreshProgress(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setInstalling(false); }
  }, []);
  useEffect(() => {
    if (!autoCheck) return;
    void check(true);
    const timer = window.setInterval(() => void check(true), CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoCheck, check]);
  return { status, progress, checking, installing, error, check, install };
}

function ProgressView({ progress }: { progress: UpdateProgress }) {
  const restarting = progress.state === 'restarting';
  const percent = restarting ? 100 : Math.round(((Math.max(progress.step, 1) - 1) / progress.totalSteps) * 100 + 100 / progress.totalSteps / 2);
  return <div className="update-progress">
    <strong>{restarting ? 'Update ready. Restarting SocialSpace…' : `Updating SocialSpace · Step ${Math.max(progress.step, 1)} of ${progress.totalSteps}: ${progress.label}…`}</strong>
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

/** Checks main in the background, offers the update, and follows it to completion at the top of every page. */
export function UpdateBanner() {
  const { status, progress, installing, error, install } = useAppUpdate(true);
  const [result, clearResult] = useUpdateResult();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (result) {
    return <div role="status" className={`update-banner ${result.succeeded ? 'done' : 'failed'}`}>
      {result.succeeded ? <CheckCircle2 size={17}/> : <Download size={17}/>}
      <span>{result.succeeded ? `SocialSpace is updated to ${short(result.toCommit)}.` : `The update to ${short(result.toCommit)} didn't install. You're still on ${short(result.fromCommit)}; try Update again.`}</span>
      <button className="update-dismiss" onClick={clearResult} aria-label="Dismiss update"><Close size={16}/></button>
    </div>;
  }
  if (progress && isActive(progress)) return <div role="status" className="update-banner"><Download size={17}/><ProgressView progress={progress}/></div>;
  if (progress?.state === 'failed') {
    return <div role="alert" className="update-banner failed">
      <Download size={17}/><span>Update failed: {progress.error}</span>
      <button className="primary-button" disabled={installing} onClick={() => void install()}>Try again</button>
    </div>;
  }
  if (!status?.updateAvailable || dismissed === status.latestCommit) return null;
  return <div role="status" className="update-banner">
    <Download size={17}/>
    <span>{error || status.blockedReason || `${commitCount(status)} on main. Update to rebuild and reinstall SocialSpace in the background.`}</span>
    {!status.blockedReason && <button className="primary-button" disabled={installing} onClick={() => void install()}>{installing ? 'Starting…' : 'Update now'}</button>}
    <button className="update-dismiss" onClick={() => setDismissed(status.latestCommit)} aria-label="Dismiss update"><Close size={16}/></button>
  </div>;
}

/** Settings card: current build, manual check, and the list of incoming changes. */
export function UpdateSettings() {
  const { status, progress, checking, installing, error, check, install } = useAppUpdate(false);
  const busy = isActive(progress);
  return <section className="settings-card update-settings">
    <h2><Download size={17}/> App updates</h2>
    <p>SocialSpace updates itself from the main branch: it pulls the latest code, rebuilds, and reinstalls in the background, then restarts.</p>
    <dl className="update-facts">
      <dt>Installed build</dt><dd>{status ? short(status.installedCommit) : 'Not checked yet'}</dd>
      {status && <><dt>Latest on main</dt><dd>{short(status.latestCommit)}</dd></>}
    </dl>
    {status && !status.updateAvailable && <p className="update-note">You're on the latest version.</p>}
    {status?.updateAvailable && <>
      <p className="update-note">{commitCount(status)} since this build:</p>
      {status.newCommits.length > 0 && <ul className="update-commits">{status.newCommits.map((commit) => <li key={commit}>{commit}</li>)}</ul>}
    </>}
    {status?.blockedReason && <p className="update-error">{status.blockedReason}</p>}
    {error && <p className="update-error" role="alert">{error}</p>}
    {busy && progress && <ProgressView progress={progress}/>}
    {progress?.state === 'failed' && <p className="update-error">Update failed: {progress.error}</p>}
    <div className="update-actions">
      <button type="button" className="outline-button" disabled={checking || installing || busy} onClick={() => void check(false)}><RefreshCw size={15}/>{checking ? 'Checking…' : 'Check for updates'}</button>
      {status?.updateAvailable && !status.blockedReason && !busy && <button type="button" className="primary-button" disabled={installing || checking} onClick={() => void install()}><Download size={15}/>{installing ? 'Starting…' : 'Update now'}</button>}
    </div>
  </section>;
}
