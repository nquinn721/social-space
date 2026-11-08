import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, X as Close } from 'lucide-react';
import { checkForUpdate, installUpdate, type UpdateStatus } from './updateService';
import './updates.css';

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const short = (commit: string | null) => (commit && commit !== 'unknown' ? commit.slice(0, 7) : 'unknown');
const errorText = (error: unknown) => (typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong.');
const commitCount = (status: UpdateStatus) => {
  const count = status.newCommits.length;
  return count ? `${count}${count >= 20 ? '+' : ''} new change${count === 1 ? '' : 's'}` : 'New changes';
};

function useAppUpdate(autoCheck: boolean) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [started, setStarted] = useState(false);
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
    try { await installUpdate(); setStarted(true); }
    catch (reason) { setError(errorText(reason)); }
    finally { setInstalling(false); }
  }, []);
  useEffect(() => {
    if (!autoCheck) return;
    void check(true);
    const timer = window.setInterval(() => void check(true), CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoCheck, check]);
  return { status, checking, installing, started, error, check, install };
}

const STARTED_TEXT = 'Update started. A window shows the build; SocialSpace closes and reopens on the new version when it finishes.';

/** Checks main in the background and offers the update at the top of every page. */
export function UpdateBanner() {
  const { status, installing, started, error, install } = useAppUpdate(true);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!status?.updateAvailable || dismissed === status.latestCommit) return null;
  return <div role="status" className="update-banner">
    <Download size={17}/>
    <span>{started ? STARTED_TEXT : error || status.blockedReason || `${commitCount(status)} on main. Update to rebuild and reinstall SocialSpace.`}</span>
    {!started && !status.blockedReason && <button className="primary-button" disabled={installing} onClick={() => void install()}>{installing ? 'Starting…' : 'Update now'}</button>}
    <button className="update-dismiss" onClick={() => setDismissed(status.latestCommit)} aria-label="Dismiss update"><Close size={16}/></button>
  </div>;
}

/** Settings card: current build, manual check, and the list of incoming changes. */
export function UpdateSettings() {
  const { status, checking, installing, started, error, check, install } = useAppUpdate(false);
  return <section className="settings-card update-settings">
    <h2><Download size={17}/> App updates</h2>
    <p>SocialSpace updates itself from the main branch: it pulls the latest code, rebuilds, and reinstalls.</p>
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
    {started && <p className="update-note">{STARTED_TEXT}</p>}
    <div className="update-actions">
      <button type="button" className="outline-button" disabled={checking || installing} onClick={() => void check(false)}><RefreshCw size={15}/>{checking ? 'Checking…' : 'Check for updates'}</button>
      {status?.updateAvailable && !status.blockedReason && !started && <button type="button" className="primary-button" disabled={installing || checking} onClick={() => void install()}><Download size={15}/>{installing ? 'Starting…' : 'Update now'}</button>}
    </div>
  </section>;
}
