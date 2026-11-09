import { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound, Pencil } from 'lucide-react';
import type { Account } from './model';
import { hasAccountPassword, revealAccountPassword, setAccountPassword } from './profileService';

function errorText(reason: unknown) { return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Something went wrong.'; }

/** Sign-in details for a saved account. The password stays in Windows Credential Manager until revealed. */
export default function AccountCredentials({ account }: { account: Account }) {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [draft, setDraft] = useState('');
  const [changing, setChanging] = useState(false);
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { hasAccountPassword(account.id).then(setHasPassword).catch((reason) => { setHasPassword(false); setError(errorText(reason)); }); }, [account.id]);
  async function load() { if (password) return password; const value = await revealAccountPassword(account.id); setPassword(value); return value; }
  async function toggle() { setError(''); try { if (!visible) await load(); setVisible(!visible); } catch (reason) { setError(errorText(reason)); } }
  async function copy(label: string, value: string | (() => Promise<string>)) {
    setError('');
    try { await navigator.clipboard.writeText(typeof value === 'string' ? value : await value()); setCopied(label); } catch (reason) { setError(errorText(reason)); }
  }
  async function save() {
    setError('');
    try { await setAccountPassword(account.id, draft); setPassword(draft); setDraft(''); setHasPassword(true); setVisible(false); setChanging(false); } catch (reason) { setError(errorText(reason)); }
  }
  const row = (label: string, value: string | undefined) => <div className="credential-row"><span>{label}</span><code>{value || '—'}</code>{value && <button type="button" className="icon-button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy(label, value)}><Copy size={15}/></button>}</div>;
  return <section className="credentials" aria-label="Sign-in details">
    <h3><KeyRound size={15}/> Sign-in details</h3>
    {row('Email', account.signupEmail)}
    {row('Username', account.handle ? `@${account.handle}` : '')}
    <div className="credential-row"><span>Password</span>
      {hasPassword && !changing ? <><code>{visible ? password : '••••••••••••••••'}</code>
        <button type="button" className="icon-button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => void toggle()}>{visible ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
        <button type="button" className="icon-button" aria-label="Copy password" onClick={() => void copy('Password', load)}><Copy size={15}/></button>
        <button type="button" className="icon-button" aria-label="Change password" onClick={() => setChanging(true)}><Pencil size={15}/></button></>
      : hasPassword === false || changing ? <><input type="password" aria-label="Save a password" placeholder={changing ? 'New password' : 'Not saved. Enter one to keep it here'} value={draft} onChange={(event) => setDraft(event.target.value)}/><button type="button" className="outline-button" disabled={!draft} onClick={() => void save()}>Save</button></>
      : <code>…</code>}
    </div>
    {copied && <p className="success-message" role="status">{copied} copied.</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
