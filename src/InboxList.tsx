import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, ArrowLeft, Check, Copy, Inbox, Mail, RefreshCw } from 'lucide-react';
import { emailConnection, listEmails, openGmailMessage, readEmail, type EmailConnection, type EmailMessage, type EmailSummary } from './emailService';
import { findCode } from './profileService';
import { errorText } from './ui';
import GmailConnect from './GmailConnect';

/** How often the inbox checks for new mail while it's on screen. */
const AUTO_REFRESH_MS = 20_000;

type Props = {
  limit?: number;
  /** Small list that swaps to the email when one is opened (wizard, overview). */
  compact?: boolean;
  /** When set, codes get a "Fill on page" action that hands the code to the caller. */
  onCode?: (code: string) => void;
  /** Keep checking for new mail while shown. */
  autoRefresh?: boolean;
  /** How often auto refresh checks, in ms. */
  refreshMs?: number;
  /** Called once for each email with a code in its subject that arrives while the list is shown. */
  onNewCode?: (code: string, email: EmailSummary) => void;
};

/** Newest inbox emails with verification codes pulled out so they can be copied or filled in. */
export default function InboxList({ limit = 10, compact = false, onCode, autoRefresh = false, refreshMs = AUTO_REFRESH_MS, onNewCode }: Props) {
  const [connection, setConnection] = useState<EmailConnection | null | undefined>(undefined);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [open, setOpen] = useState<EmailMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const loading = useRef(false);
  // Mail already there when the list opens is old; only mail that arrives later counts as new.
  const seen = useRef<Set<number> | null>(null);
  const newCode = useRef(onNewCode);
  newCode.current = onNewCode;

  const refresh = useCallback(async (quiet = false) => {
    if (loading.current) return;
    loading.current = true;
    if (!quiet) { setBusy(true); setError(''); }
    try {
      const current = await emailConnection();
      setConnection(current);
      if (current) {
        const list = await listEmails({ limit });
        setEmails(list);
        const first = seen.current === null;
        seen.current ??= new Set();
        for (const email of list) {
          if (seen.current.has(email.uid)) continue;
          seen.current.add(email.uid);
          const found = findCode(email.subject);
          if (!first && found) newCode.current?.(found, email);
        }
      }
    } catch (reason) { if (!quiet) setError(errorText(reason, 'The request failed.')); setConnection((value) => value ?? null); }
    finally { loading.current = false; if (!quiet) setBusy(false); }
  }, [limit]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(true), refreshMs);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh, refreshMs]);

  async function show(uid: number) {
    setBusy(true); setError('');
    try { setOpen(await readEmail(uid)); } catch (reason) { setError(errorText(reason, 'The request failed.')); } finally { setBusy(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(text); } catch { setCopied(''); }
  }
  const code = open ? findCode(`${open.subject}\n${open.body}`) : null;

  if (connection === null) return <div className="inbox empty">
    <div className="inbox-head"><Mail size={16}/><strong>Verification codes</strong></div>
    {error && <div className="error-message" role="alert">{error}</div>}
    <GmailConnect compact={compact} onConnected={(value) => { setError(''); setConnection(value); void refresh(); }}/>
  </div>;

  const reader = open && <div className="inbox-message">
    {compact && <button type="button" className="text-button" onClick={() => setOpen(null)}><ArrowLeft size={14}/> Back to inbox</button>}
    <h3>{open.subject || '(no subject)'}</h3><small>{open.from} · {open.date}</small>
    {code && <div className="inbox-code"><span>Code</span><strong>{code}</strong>
      <button type="button" className="primary-button" onClick={() => void copy(code)}>{copied === code ? <Check size={14}/> : <Copy size={14}/>} {copied === code ? 'Copied' : 'Copy'}</button>
      {onCode && <button type="button" className="outline-button" onClick={() => onCode(code)}>Fill on page</button>}
    </div>}
    <pre>{open.body}</pre>
    {connection?.kind === 'gmail' && <button type="button" className="ghost-button small-button" onClick={() => void openGmailMessage(open.uid).catch((reason) => setError(errorText(reason, 'Could not open Gmail.')))}><AppWindow size={14}/> Open in Gmail</button>}
  </div>;

  const list = <ul className="inbox-list">
    {!emails.length && !busy && <li className="inbox-none">{connection?.kind === 'gmail' ? 'No unread email. New mail shows up here after the site sends it.' : 'No emails yet. New mail shows up here after the site sends it.'}</li>}
    {emails.map((email) => {
      const subjectCode = findCode(email.subject);
      return <li key={email.uid} className={`${email.unread ? 'unread' : ''} ${open?.uid === email.uid ? 'selected' : ''}`}>
        <button type="button" onClick={() => void show(email.uid)}><strong>{email.subject || '(no subject)'}</strong><small>{email.from}{email.date ? ` · ${email.date}` : ''}</small></button>
        {subjectCode && <button type="button" className="code-chip" title={onCode ? 'Fill this code on the sign-up page' : 'Copy code'} aria-label={onCode ? `Fill code ${subjectCode} on page` : `Copy code ${subjectCode}`}
          onClick={() => { if (onCode) onCode(subjectCode); else void copy(subjectCode); }}>{copied === subjectCode ? <Check size={13}/> : null}{subjectCode}</button>}
      </li>;
    })}
  </ul>;

  return <div className={`inbox ${compact ? 'compact' : ''}`}>
    <div className="inbox-head"><Mail size={16}/><strong>{connection ? connection.username : 'Inbox'}</strong>
      {autoRefresh && <span className="live"><span className="dot"/>Live</span>}
      <button type="button" className="ghost-button small-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/> {busy ? 'Checking…' : 'Refresh'}</button></div>
    {error && <div className="error-message" role="alert" style={{ margin: 10 }}>{error}</div>}
    {compact ? (open ? reader : list) : <div className="inbox-body">{list}{reader || <div className="inbox-placeholder"><div><Inbox size={36}/><p>Pick an email to read it. Codes are shown at the top.</p></div></div>}</div>}
  </div>;
}
