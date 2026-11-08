import { useEffect, useState, type FormEvent } from 'react';
import './assistant/assistant.css';
import { AppWindow, Check, Copy, Eye, ImagePlus, RefreshCw, X as Close } from 'lucide-react';
import { BIO_LIMITS, createAccount, getPlatform, PLATFORMS, type Account, type Platform } from './model';
import { chooseImageFile, ensureAccountPassword, fillSiteForm, formFieldsFor, loadImagePreview, openPlatformWindow, revealAccountPassword } from './profileService';
import InboxList from './InboxList';

/** All new accounts verify through this inbox unless changed in the form. */
export const DEFAULT_SIGNUP_EMAIL = 'softwings25@gmail.com';
type Step = 'details' | 'signup' | 'profile';
const STEPS: Step[] = ['details', 'signup', 'profile'];
function errorText(reason: unknown) { return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Something went wrong.'; }

export default function CreateAccountWizard({ onSave, onClose, initialPlatform = 'instagram' }: { onSave: (account: Account) => Promise<void>; onClose: () => void; initialPlatform?: Platform }) {
  const [step, setStep] = useState<Step>('details');
  const [platform, setPlatform] = useState<Platform>(initialPlatform);
  const [label, setLabel] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [website, setWebsite] = useState('');
  const [signupEmail, setSignupEmail] = useState(DEFAULT_SIGNUP_EMAIL);
  const [imagePath, setImagePath] = useState('');
  const [preview, setPreview] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [windowId, setWindowId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setPreview(''); if (imagePath) loadImagePreview(imagePath).then(setPreview).catch(() => setPreview('')); }, [imagePath]);
  const bioLimit = BIO_LIMITS[platform];
  const name = getPlatform(platform).name;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function pickImage() { await run(async () => { const path = await chooseImageFile(); if (path) setImagePath(path); }); }

  function start(event: FormEvent) {
    event.preventDefault();
    if (!label.trim() || bio.trim().length > bioLimit) return;
    void run(async () => {
      const next: Account = { ...createAccount(platform, label, handle, 'planned', ''), displayName: displayName.trim(), bio: bio.trim(), website: website.trim(), signupEmail: signupEmail.trim(), imagePath };
      await onSave(next);
      setAccount(next);
      await ensureAccountPassword(next.id);
      const id = await openPlatformWindow(platform, 'create');
      setWindowId(id);
      await fillSiteForm(id, formFieldsFor(next), { accountId: next.id, includePassword: true, keepFilling: true });
      setStep('signup');
    });
  }
  const refill = (code?: string) => run(async () => {
    if (!account || !windowId) return;
    await fillSiteForm(windowId, formFieldsFor(account, code), { accountId: account.id, includePassword: !code, keepFilling: true });
    setNote(code ? `Entered code ${code}. Check it, then press the button on the page.` : 'Filled the empty fields on the current page.');
  });
  const reopen = () => run(async () => {
    if (!account) return;
    const id = await openPlatformWindow(account.platform, 'create');
    setWindowId(id);
    await fillSiteForm(id, formFieldsFor(account), { accountId: account.id, includePassword: true, keepFilling: true });
  });
  const showPassword = () => run(async () => { if (account) setPassword(await revealAccountPassword(account.id)); });
  const copyPassword = () => run(async () => {
    if (!account) return;
    await navigator.clipboard.writeText(password || await revealAccountPassword(account.id));
    setNote('Password copied.');
  });
  const created = () => run(async () => {
    if (!account) return;
    const active = { ...account, status: 'active' as const, imagePath };
    await onSave(active); setAccount(active); setStep('profile');
  });
  const fillProfile = () => run(async () => {
    if (!account) return;
    const current = { ...account, imagePath };
    if (imagePath !== account.imagePath) { await onSave(current); setAccount(current); }
    const id = await openPlatformWindow(account.platform, 'manage');
    setWindowId(id);
    await fillSiteForm(id, formFieldsFor(current), { imagePath: imagePath || undefined, accountId: account.id, keepFilling: true });
    setNote('Opened your profile settings and filled what matched. Check it, then save on the page.');
  });

  return <div className="modal-backdrop"><section className="dialog wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
    <div className="dialog-header"><div><p className="greeting">Guided sign-up</p><h2 id="wizard-title">Create an account</h2></div><button className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><Close size={20}/></button></div>
    <div className="wizard-steps" aria-hidden="true">{STEPS.map((item, index) => <span key={item} className={STEPS.indexOf(step) >= index ? 'done' : ''}/>)}</div>

    {step === 'details' && <form onSubmit={start}>
      <p className="dialog-copy">Pick a social and fill in what you know. Socialspace opens the sign-up page, fills each step as you go, and saves a strong password for you. You press every button and handle any captcha.</p>
      <label htmlFor="wizard-platform">Social</label>
      <select id="wizard-platform" value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>{PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <label htmlFor="wizard-name">Account name</label>
      <input id="wizard-name" autoFocus required maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Soft Wings Studio"/>
      <label htmlFor="wizard-handle">Username you want <span>optional</span></label>
      <input id="wizard-handle" maxLength={120} value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@softwings"/>
      <label htmlFor="wizard-display">Display name <span>optional</span></label>
      <input id="wizard-display" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)}/>
      <label htmlFor="wizard-bio">Profile description <span className={`bio-count ${bio.trim().length > bioLimit ? 'over' : ''}`}>{bio.trim().length}/{bioLimit}</span></label>
      <textarea id="wizard-bio" rows={3} maxLength={1000} value={bio} onChange={(event) => setBio(event.target.value)}/>
      <label htmlFor="wizard-website">Website <span>optional</span></label>
      <input id="wizard-website" maxLength={300} value={website} onChange={(event) => setWebsite(event.target.value)}/>
      <label htmlFor="wizard-email">Sign-up email</label>
      <input id="wizard-email" type="email" required maxLength={320} value={signupEmail} onChange={(event) => setSignupEmail(event.target.value)}/>
      <label>Profile image <span>optional, you can add it later</span></label>
      <div className="profile-image">{preview && <img src={preview} alt="Profile preview"/>}<span>{imagePath ? imagePath.split(/[\\/]/).pop() : 'No image chosen'}</span><button type="button" className="outline-button" disabled={busy} onClick={() => void pickImage()}><ImagePlus size={15}/> Choose</button></div>
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !label.trim() || !signupEmail.trim() || bio.trim().length > bioLimit}><AppWindow size={15}/> {busy ? 'Opening…' : `Open ${name} sign-up`}</button></div>
    </form>}

    {step === 'signup' && account && <>
      <ol>
        <li>The {name} sign-up window is open with your details filled in.</li>
        <li>Check each page, then press Next or Sign up yourself. New pages fill in automatically.</li>
        <li>When {name} emails a code to {account.signupEmail}, open the email below and copy it or fill it on the page.</li>
        <li>Handle any captcha, birthday, or phone check yourself.</li>
      </ol>
      <div className="password-row">Password saved for this account: <code>{password || '••••••••••••••••••••'}</code><button type="button" className="icon-button" aria-label="Show password" onClick={() => void showPassword()}><Eye size={16}/></button><button type="button" className="icon-button" aria-label="Copy password" onClick={() => void copyPassword()}><Copy size={16}/></button></div>
      <div className="wizard-actions"><button type="button" className="outline-button" disabled={busy} onClick={() => void refill()}><RefreshCw size={14}/> Fill this page again</button><button type="button" className="outline-button" disabled={busy} onClick={() => void reopen()}><AppWindow size={14}/> Reopen sign-up</button></div>
      <InboxList compact limit={8} onCode={(code) => void refill(code)}/>
      {note && <p className="success-message" role="status">{note}</p>}
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="outline-button" disabled={busy} onClick={onClose}>Finish later</button><button type="button" className="primary-button" disabled={busy} onClick={() => void created()}><Check size={15}/> My account is created</button></div>
    </>}

    {step === 'profile' && account && <>
      <p className="dialog-copy">Nice. {account.label} is saved as in use. Add the profile picture and description now, or come back to it from Accounts.</p>
      <label>Profile image</label>
      <div className="profile-image">{preview && <img src={preview} alt="Profile preview"/>}<span>{imagePath ? imagePath.split(/[\\/]/).pop() : 'No image chosen'}</span><button type="button" className="outline-button" disabled={busy} onClick={() => void pickImage()}><ImagePlus size={15}/> Choose</button></div>
      {note && <p className="success-message" role="status">{note}</p>}
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="outline-button" disabled={busy} onClick={onClose}>Done</button><button type="button" className="primary-button" disabled={busy} onClick={() => void fillProfile()}><AppWindow size={15}/> Open profile settings and fill</button></div>
    </>}
  </section></div>;
}
