import { useEffect, useState, type FormEvent } from 'react';
import { connectEmail, disconnectEmail, emailConnection, type EmailConnection } from './emailService';

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
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setMessage(''); try { await action(); } catch (reason) { setError(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'The request failed.'); } finally { setBusy(false); } }
  function connect(event: FormEvent) {
    event.preventDefault();
    void run(async () => { setConnection(await connectEmail(host.trim(), Number(port) || 993, username.trim(), password)); setPassword(''); setMessage('Email connected. The assistant can now read your inbox.'); });
  }
  return <section className="settings-card email-settings"><h2>Email for the assistant</h2>
    {!available ? <p>Open the desktop app to connect your email.</p> : connection ? <>
      <p>Connected to {connection.username} on {connection.host}. The assistant reads your inbox without marking anything read, and only on this computer.</p>
      <button className="remove-button disconnect" disabled={busy} onClick={() => void run(async () => { await disconnectEmail(); setConnection(null); setMessage('Email disconnected.'); })}>Disconnect email</button>
    </> : <>
      <p>Connect over IMAP so the assistant can read sign-up and verification emails. Gmail and Outlook need an app password, not your normal password. It is stored in Windows Credential Manager.</p>
      <form onSubmit={connect}>
        <div className="row"><div><label htmlFor="imap-host">Mail server</label><input id="imap-host" value={host} onChange={(event) => setHost(event.target.value)}/></div><div><label htmlFor="imap-port">Port</label><input id="imap-port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)}/></div></div>
        <label htmlFor="imap-user">Email address</label><input id="imap-user" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)}/>
        <label htmlFor="imap-password">App password</label><input id="imap-password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)}/>
        <button className="primary-button" disabled={busy || !host.trim() || !username.trim() || !password}>Connect email</button>
      </form>
    </>}
    {busy && <p role="status">Working…</p>}{message && <p className="success-message" role="status">{message}</p>}{error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
