import { useEffect, useState, type FormEvent } from 'react';
import { Mail } from 'lucide-react';
import { connectEmail, disconnectEmail, emailConnection, type EmailConnection } from './emailService';
import GmailConnect from './GmailConnect';
import { errorText } from './ui';

export default function EmailSettings() {
  const [connection, setConnection] = useState<EmailConnection | null>(null);
  const [available, setAvailable] = useState(false);
  const [host, setHost] = useState('imap.gmail.com');
  const [port, setPort] = useState('993');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { emailConnection().then((value) => { setConnection(value); setAvailable(true); }).catch(() => setAvailable(false)); }, []);
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setMessage(''); try { await action(); } catch (reason) { setError(errorText(reason, 'The request failed.')); } finally { setBusy(false); } }
  function connect(event: FormEvent) {
    event.preventDefault();
    void run(async () => { setConnection(await connectEmail(host.trim(), Number(port) || 993, username.trim(), password)); setPassword(''); setMessage('Email connected. Verification codes now show up in the Inbox.'); });
  }
  return <section className="settings-card email-settings" id="email">
    <h2><Mail size={17}/> Email inbox</h2>
    <p>Where sign-up and verification emails arrive. Connected mail shows in Inbox, inside Create accounts, and to the assistant. Nothing is marked as read.</p>
    {!available ? <div className="status-line off"><span className="dot"/><span>Open the desktop app to connect your email.</span></div> : connection ? <>
      <div className="status-line"><span className="dot"/><span>Connected to <strong>{connection.username}</strong> on {connection.host}</span><button className="remove-button" style={{ marginRight: 0 }} disabled={busy} onClick={() => void run(async () => { await disconnectEmail(); setConnection(null); setMessage('Email disconnected.'); })}>Disconnect</button></div>
      {connection.kind === 'gmail' && <p>Reading through your Gmail sign-in in the app. The inbox shows unread mail, which is where new codes land.</p>}
    </> : <>
      <div className="gmail-signin">
        <h3>Sign in to Gmail in the app <span className="pill-tag">Recommended</span></h3>
        <GmailConnect onConnected={(value) => { setConnection(value); setMessage('Gmail connected. New verification emails now show up in the Inbox.'); }}/>
      </div>
      <details className="imap-option"><summary>Use an app password instead (IMAP)</summary><form onSubmit={connect}>
      <p>Gmail and Outlook need an app password, not your normal password. It's stored in Windows Credential Manager.</p>
      <label htmlFor="imap-user">Email address</label><input id="imap-user" autoComplete="off" placeholder="softwings25@gmail.com" value={username} onChange={(event) => setUsername(event.target.value)}/>
      <label htmlFor="imap-password">App password</label><input id="imap-password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)}/>
      <div className="row"><div><label htmlFor="imap-host">Mail server</label><input id="imap-host" value={host} onChange={(event) => setHost(event.target.value)}/></div><div><label htmlFor="imap-port">Port</label><input id="imap-port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)}/></div></div>
      <button className="primary-button" disabled={busy || !host.trim() || !username.trim() || !password}>{busy ? 'Connecting…' : 'Connect email'}</button>
    </form></details>
    </>}
    {message && <p className="success-message" role="status">{message}</p>}{error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
