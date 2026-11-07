import { useEffect, useState, type FormEvent } from 'react';
import { connectX, disconnectX, postToX, xConnection, type XIdentity } from './xService';

export default function XPublisher() {
  const [identity, setIdentity] = useState<XIdentity | null>(null);
  const [available, setAvailable] = useState(false);
  const [clientId, setClientId] = useState('');
  const [post, setPost] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { xConnection().then((value) => { setIdentity(value); setAvailable(true); }).catch(() => setAvailable(false)); }, []);
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setMessage(''); try { await action(); } catch (reason) { setError(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'The request failed.'); } finally { setBusy(false); } }
  function connect(event: FormEvent) { event.preventDefault(); if (!clientId.trim()) return; void run(async () => { setIdentity(await connectX(clientId.trim())); setClientId(''); setMessage('X account connected.'); }); }
  function publish(event: FormEvent) { event.preventDefault(); if (!post.trim()) return; void run(async () => { await postToX(post.trim()); setPost(''); setMessage('Your post was published to X.'); }); }
  return <section className="settings-card x-publisher"><h2>Publish directly to X</h2>{!available ? <p>Open the desktop app to connect an X account.</p> : identity ? <><p>Connected as @{identity.username}. Posting uses your X developer app and may incur API charges.</p><form onSubmit={publish}><label htmlFor="x-post">Your post</label><textarea id="x-post" rows={4} value={post} maxLength={280} onChange={(event) => setPost(event.target.value)} placeholder="What would you like to share?"/><p>If a request fails after sending, check X before trying again; the post may have been published.</p><button className="primary-button" disabled={busy || !post.trim()}>Post to X</button></form><button className="remove-button disconnect" disabled={busy} onClick={() => void run(async () => { await disconnectX(); setIdentity(null); setMessage('X account disconnected.'); })}>Disconnect X</button></> : <><p>Connect an X developer app with read and write access. In the app settings, use a Native App and register this callback URL:</p><input aria-label="X callback URL" readOnly value="http://127.0.0.1:49173/callback"/><p>X API access may require billing. Signing in opens X in an app window; tokens are stored in Windows Credential Manager.</p><form onSubmit={connect}><label htmlFor="x-client-id">X OAuth 2.0 client ID</label><input id="x-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" placeholder="Your developer app client ID"/><button className="primary-button" disabled={busy || !clientId.trim()}>Connect X account</button></form></>}{busy && <p role="status">Working…</p>}{message && <p className="success-message" role="status">{message}</p>}{error && <div className="error-message" role="alert">{error}</div>}</section>;
}

