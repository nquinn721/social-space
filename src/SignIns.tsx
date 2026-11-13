import { useEffect, useState, type FormEvent } from 'react';
import { Copy, DatabaseBackup, Eye, EyeOff, KeyRound, Pencil, Upload } from 'lucide-react';
import { getPlatform, PLATFORMS, type Account, type Workspace } from './model';
import { mergeRestored } from './brands';
import { exportSignIns, hasAccountPassword, importSignIns, onPasswordSaved, revealAccountPassword, setAccountPassword } from './profileService';
import { BrandMark, errorText } from './ui';

const ORDER = PLATFORMS.map((platform) => platform.id);

/** One account's password: hidden until asked, copyable, and changeable or addable in place. */
export function PasswordCell({ account }: { account: Account }) {
  return <PasswordField id={account.id} label={`${getPlatform(account.platform).name} ${account.handle ? `@${account.handle}` : account.label}`}/>;
}

/** A saved password by its Credential Manager id: a profile's, or a developer account's. */
export function PasswordField({ id, label }: { id: string; label: string }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    const check = () => { hasAccountPassword(id).then(setSaved).catch(() => setSaved(false)); setValue(''); setShown(false); };
    check();
    return onPasswordSaved(id, check);
  }, [id]);
  async function load() { if (value) return value; const next = await revealAccountPassword(id); setValue(next); return next; }
  async function act(action: () => Promise<void>) { setNote(''); try { await action(); } catch (reason) { setNote(errorText(reason)); } }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    void act(async () => { await setAccountPassword(id, draft); setValue(draft); setDraft(''); setSaved(true); setEditing(false); setShown(false); setNote('Saved.'); });
  }
  if (saved === null) return <span className="muted">…</span>;
  if (!saved || editing) return <form className="password-edit" onSubmit={save}>
    <input type="password" aria-label={`New password for ${label}`} placeholder={saved ? 'New password' : 'Not saved yet. Enter it'} value={draft} onChange={(event) => setDraft(event.target.value)} autoComplete="off"/>
    <button className="outline-button small-button" disabled={!draft}>Save</button>
    {editing && <button type="button" className="ghost-button small-button" onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button>}
    {note && <small role="status">{note}</small>}
  </form>;
  return <span className="password-cell">
    <code>{shown ? value : '••••••••••'}</code>
    <button type="button" className="icon-button" aria-label={`${shown ? 'Hide' : 'Show'} password for ${label}`} onClick={() => void act(async () => { if (!shown) await load(); setShown(!shown); })}>{shown ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
    <button type="button" className="icon-button" aria-label={`Copy password for ${label}`} onClick={() => void act(async () => { await navigator.clipboard.writeText(await load()); setNote('Copied.'); })}><Copy size={14}/></button>
    <button type="button" className="icon-button" aria-label={`Change password for ${label}`} onClick={() => setEditing(true)}><Pencil size={14}/></button>
    {note && <small role="status">{note}</small>}
  </span>;
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return <span className="muted">Not set</span>;
  return <span className="copy-text"><span>{text}</span><button type="button" className="icon-button" aria-label={`Copy ${label}`} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => undefined)}>{copied ? '✓' : <Copy size={14}/>}</button></span>;
}

type Props = { workspace: Workspace; busy: boolean; onEdit: (account: Account) => void; onRestore: (next: Workspace, message: string) => Promise<boolean | undefined>; showBackup?: boolean };

/** Every account's username, email and password in one place, with an encrypted backup. */
export default function SignIns({ workspace, busy, onEdit, onRestore, showBackup = true }: Props) {
  const [mode, setMode] = useState<'backup' | 'restore' | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const brandName = (account: Account) => workspace.brands.find((brand) => brand.id === account.brandId)?.name ?? account.label;
  const rows = [...workspace.accounts].sort((a, b) => brandName(a).localeCompare(brandName(b)) || ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (working || !mode) return;
    setWorking(true); setError(''); setMessage('');
    (async () => {
      if (mode === 'backup') {
        const file = await exportSignIns(passphrase);
        if (file) setMessage(`Saved ${file}. Keep it somewhere safe, like a USB stick or cloud drive, and remember the passphrase. Without it the file can't be opened.`);
      } else {
        const restored = await importSignIns(passphrase);
        if (!restored) return;
        const merged = mergeRestored(workspace, restored.workspace);
        await onRestore(merged.workspace, `Restored ${restored.passwordsRestored} passwords and ${merged.added} missing accounts from the backup.`);
      }
      setPassphrase(''); setMode(null);
    })().catch((reason) => setError(errorText(reason))).finally(() => setWorking(false));
  }

  return <section className="sign-ins" aria-label="Sign-ins">
    <div className="sign-ins-head">
      <div><h2><KeyRound size={16}/> Sign-ins</h2><p>{showBackup ? "Every account's username, email and password. Passwords are kept in Windows Credential Manager on this PC." : 'Username, email and password for each profile.'}</p></div>
      {showBackup && <div className="heading-buttons">
        <button type="button" className="primary-button small-button" disabled={working} onClick={() => { setMode('backup'); setError(''); }}><DatabaseBackup size={14}/> Back up sign-ins</button>
        <button type="button" className="outline-button small-button" disabled={working} onClick={() => { setMode('restore'); setError(''); }}><Upload size={14}/> Restore</button>
      </div>}
    </div>
    {mode && <form className="card backup-form" onSubmit={submit}>
      <label htmlFor="backup-passphrase">{mode === 'backup' ? 'Choose a passphrase to lock the backup file' : 'Passphrase of the backup file'}</label>
      <div className="inline-add"><input id="backup-passphrase" type="password" autoComplete="new-password" minLength={8} value={passphrase} onChange={(event) => setPassphrase(event.target.value)}/>
        <button className="primary-button small-button" disabled={working || passphrase.length < 8}>{working ? 'Working…' : mode === 'backup' ? 'Save backup file' : 'Choose file and restore'}</button>
        <button type="button" className="ghost-button small-button" disabled={working} onClick={() => { setMode(null); setPassphrase(''); }}>Cancel</button></div>
      <small>{mode === 'backup' ? 'At least 8 characters. The file holds every username, email and password, encrypted with this passphrase.' : 'Passwords go back into Credential Manager, and accounts missing here are added back.'}</small>
    </form>}
    {message && <p className="success-message" role="status">{message}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
    {rows.length === 0 ? <p className="footnote">No accounts yet.</p> : <div className="card sign-ins-table" role="table" aria-label="All sign-ins">
      <div className="sign-ins-row head" role="row"><span role="columnheader">Account</span><span role="columnheader">Username</span><span role="columnheader">Email</span><span role="columnheader">Password</span></div>
      {rows.map((account) => <div className="sign-ins-row" role="row" key={account.id}>
        <span role="cell"><button type="button" className="text-button" onClick={() => onEdit(account)} disabled={busy}><BrandMark platform={account.platform} small/> {brandName(account)}</button><em className={`pill ${account.status}`}>{account.status === 'active' ? 'Live' : 'Not created yet'}</em></span>
        <span role="cell"><CopyText text={account.handle ? account.handle : ''} label={`username for ${getPlatform(account.platform).name} ${brandName(account)}`}/></span>
        <span role="cell"><CopyText text={account.signupEmail ?? ''} label={`email for ${getPlatform(account.platform).name} ${brandName(account)}`}/></span>
        <span role="cell"><PasswordCell account={account}/></span>
      </div>)}
    </div>}
  </section>;
}
