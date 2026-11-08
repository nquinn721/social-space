import { useEffect, useRef, useState } from 'react';
import { AppWindow, Check } from 'lucide-react';
import { connectGmailSession, openGmailSignIn, type EmailConnection } from './emailService';
import { errorText } from './ui';

/** How often to check whether the Gmail sign-in finished, and for how long. */
const CHECK_EVERY_MS = 4_000;
const GIVE_UP_AFTER_MS = 10 * 60_000;

/**
 * One button: opens Gmail's sign-in in an app window, then notices by itself
 * when the sign-in is done and connects the inbox. No app password needed.
 */
export default function GmailConnect({ onConnected, compact = false }: { onConnected: (connection: EmailConnection) => void; compact?: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = useRef(onConnected);
  done.current = onConnected;

  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const started = Date.now();
    const check = async () => {
      if (stopped) return;
      try { const connection = await connectGmailSession(); if (!stopped) { setWaiting(false); done.current(connection); } return; }
      catch { /* not signed in yet */ }
      if (Date.now() - started > GIVE_UP_AFTER_MS) { setWaiting(false); setError('Still not signed in. Press Sign in to Gmail to try again.'); return; }
      if (!stopped) timer = window.setTimeout(() => void check(), CHECK_EVERY_MS);
    };
    let timer = window.setTimeout(() => void check(), CHECK_EVERY_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [waiting]);

  async function signIn() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      // Already signed in from an earlier visit? Then there is nothing to open.
      try { done.current(await connectGmailSession()); return; } catch { /* needs a sign-in */ }
      await openGmailSignIn();
      setWaiting(true);
    } catch (reason) { setError(errorText(reason, 'Could not open Gmail.')); }
    finally { setBusy(false); }
  }
  async function checkNow() {
    setBusy(true); setError('');
    try { const connection = await connectGmailSession(); setWaiting(false); done.current(connection); }
    catch (reason) { setError(errorText(reason, 'Not signed in yet.')); }
    finally { setBusy(false); }
  }

  return <div className={`gmail-connect ${compact ? 'compact' : ''}`}>
    {waiting
      ? <p role="status">Sign in to Gmail in the window that opened. This connects by itself when you're done, then you can close that window.</p>
      : !compact && <p>Sign in to Gmail once and new mail shows up here. No app password needed.</p>}
    <div className="row-buttons">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void signIn()}><AppWindow size={15}/> {waiting ? 'Open the sign-in again' : 'Sign in to Gmail'}</button>
      {waiting && <button type="button" className="outline-button" disabled={busy} onClick={() => void checkNow()}><Check size={15}/> I'm signed in</button>}
    </div>
    {error && <div className="error-message" role="alert">{error}</div>}
  </div>;
}
