import { useEffect, useState } from 'react';
import './assistant/assistant.css';
import { Copy, Mail, RefreshCw } from 'lucide-react';
import { emailConnection, listEmails, readEmail, type EmailConnection, type EmailMessage, type EmailSummary } from './emailService';
import { findCode } from './profileService';

function errorText(reason: unknown) { return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'The request failed.'; }

/** Shows the newest inbox emails and pulls out verification codes to copy. */
export default function InboxList({ limit = 10, compact = false, onCode }: { limit?: number; compact?: boolean; onCode?: (code: string) => void }) {
  const [connection, setConnection] = useState<EmailConnection | null | undefined>(undefined);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [open, setOpen] = useState<EmailMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try {
      const current = await emailConnection();
      setConnection(current);
      if (current) setEmails(await listEmails({ limit }));
    } catch (reason) { setError(errorText(reason)); setConnection((value) => value ?? null); } finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function show(uid: number) {
    setBusy(true); setError('');
    try { setOpen(await readEmail(uid)); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(text); } catch { setCopied(''); }
  }
  const code = open ? findCode(`${open.subject}\n${open.body}`) : null;
  if (connection === null) return <div className="inbox empty">{error ? <div className="error-message" role="alert">{error}</div> : <p>Connect your email under Settings → Email for the assistant to see verification emails here.</p>}</div>;
  return <div className={`inbox ${compact ? 'compact' : ''}`}>
    <div className="inbox-head"><Mail size={16}/><strong>{connection ? connection.username : 'Inbox'}</strong><button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/> {busy ? 'Checking…' : 'Refresh'}</button></div>
    {error && <div className="error-message" role="alert">{error}</div>}
    {open ? <div className="inbox-message">
      <button type="button" className="text-button" onClick={() => setOpen(null)}>← Back to inbox</button>
      <h3>{open.subject || '(no subject)'}</h3><small>{open.from} · {open.date}</small>
      {code && <div className="inbox-code"><span>Code</span><strong>{code}</strong><button type="button" className="primary-button" onClick={() => void copy(code)}><Copy size={14}/> {copied === code ? 'Copied' : 'Copy'}</button>{onCode && <button type="button" className="outline-button" onClick={() => onCode(code)}>Fill on page</button>}</div>}
      <pre>{open.body}</pre>
    </div> : <ul className="inbox-list">
      {!emails.length && !busy && <li className="inbox-none">No emails yet. Press Refresh after the site sends one.</li>}
      {emails.map((email) => <li key={email.uid}><button type="button" className={email.unread ? 'unread' : ''} onClick={() => void show(email.uid)}><strong>{email.subject || '(no subject)'}</strong><small>{email.from}</small></button></li>)}
    </ul>}
  </div>;
}
