import { useState, type FormEvent } from 'react';
import { Loader2, RefreshCw, Users } from 'lucide-react';
import type { TeamSync } from './useTeamSync';
import { usePartnerReviewContext } from './usePartnerReview';
import { exportReviewKey } from './reviewService';
import { errorText } from './ui';

const MIN_PASSPHRASE = 8;

function when(ms: number) {
  if (!ms) return 'not yet';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : new Date(ms).toLocaleString();
}

/** Settings: share brands, accounts and saved sign-ins with the partner's copy of the app. */
export default function TeamSyncSettings({ sync }: { sync: TeamSync }) {
  const review = usePartnerReviewContext();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const enabled = Boolean(sync.status?.enabled);

  async function run(action: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  function turnOn(event: FormEvent) {
    event.preventDefault();
    if (passphrase.length < MIN_PASSPHRASE) { setError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`); return; }
    if (passphrase !== confirm) { setError('The two passphrases are different.'); return; }
    void run(async () => {
      const created = await sync.enable(passphrase);
      setPassphrase(''); setConfirm('');
      setNote(created ? 'Sharing is on. Your brands, accounts and sign-ins are uploading now. Type the same passphrase in your partner\'s app.' : 'Joined. The shared brands and accounts are coming in now.');
    });
  }
  const turnOff = () => {
    if (!window.confirm('Stop sharing on this PC? Everything stays here and in the cloud; this PC just stops syncing.')) return;
    void run(() => sync.disable());
  };
  const saveKey = () => void run(async () => { const name = await exportReviewKey(); if (name) setNote(`Saved ${name}. Send it to your partner privately, not by public link.`); });

  return <section className="settings-card" id="team-sync">
    <h2><Users size={17}/> Shared accounts</h2>
    <p>Share your brands, accounts, saved passwords and social connections with your partner's copy of Social Space. Changes show up on the other PC within a minute. Everything is encrypted on this PC with a team passphrase before it is uploaded, so the cloud only ever holds scrambled data. Videos stay on the PC that made them.</p>
    {!review?.connection ? <>
      <div className="status-line off"><span className="dot"/><span>Connect Partner review above first. Sharing uses the same cloud project and key file.</span></div>
    </> : enabled ? <>
      <div className={`status-line ${sync.error ? 'off' : ''}`}><span className="dot"/><span>{sync.syncing ? 'Syncing…' : `Sharing is on. Last synced ${when(sync.status?.lastSyncedAt ?? 0)}.`}</span>
        <button type="button" className="ghost-button small-button" disabled={sync.syncing} onClick={() => void sync.syncNow()}><RefreshCw size={14}/> Sync now</button>
        <button type="button" className="ghost-button small-button" disabled={working} onClick={turnOff}>Turn off</button>
      </div>
      {sync.error && <p className="footnote">{sync.error}</p>}
      <p className="footnote">To set up your partner's PC: install Social Space there, connect Partner review with the same key file, then type the team passphrase here.</p>
      <button type="button" className="outline-button small-button" disabled={working} onClick={saveKey}>Save the key file for your partner</button>
    </> : <form onSubmit={turnOn}>
      <div className="status-line off"><span className="dot"/><span>Not sharing. Your accounts are only on this PC.</span></div>
      <p className="footnote">The first PC picks the team passphrase; the other PC types the same one. Nobody can read the shared data without it, so keep it somewhere safe. If you forget it, turn sharing off on both PCs and start again.</p>
      <label htmlFor="team-passphrase">Team passphrase</label>
      <input id="team-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)}/>
      <label htmlFor="team-passphrase-confirm">Type it again</label>
      <input id="team-passphrase-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)}/>
      <button className="primary-button" disabled={working || !passphrase || !confirm}>{working ? <><Loader2 size={15} className="spin"/> Checking…</> : 'Turn on sharing'}</button>
    </form>}
    {note && <p className="footnote" role="status">{note}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
