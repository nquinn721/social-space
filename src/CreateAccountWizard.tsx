import { useEffect, useState, type FormEvent } from 'react';
import './assistant/assistant.css';
import { AppWindow, Check, Copy, Eye, ImagePlus, RefreshCw, SkipForward, Sparkles, X as Close } from 'lucide-react';
import { suggestProfile } from './assistant/suggest';
import { BIO_LIMITS, createAccount, getPlatform, PLATFORMS, type Account, type Platform } from './model';
import { chooseImageFile, ensureSharedPassword, fillSiteForm, formFieldsFor, loadImagePreview, openPlatformWindow, revealAccountPassword } from './profileService';
import InboxList from './InboxList';

/** All new accounts verify through this inbox unless changed in the form. */
export const DEFAULT_SIGNUP_EMAIL = 'softwings25@gmail.com';
type Step = 'details' | 'signup' | 'profile';
const STEPS: Step[] = ['details', 'signup', 'profile'];
type Outcome = 'created' | 'skipped';
function errorText(reason: unknown) { return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Something went wrong.'; }

/** The tightest description limit among the chosen socials, so one description fits them all. */
export function sharedBioLimit(platforms: Platform[]) {
  const limits = platforms.map((platform) => ({ platform, limit: BIO_LIMITS[platform] }));
  return limits.reduce((tightest, item) => item.limit < tightest.limit ? item : tightest, limits[0] ?? { platform: 'youtube' as Platform, limit: BIO_LIMITS.youtube });
}

/**
 * Creates the same account on every chosen social, one sign-up at a time.
 * The social list comes from PLATFORMS, so a newly supported social is included automatically.
 */
export default function CreateAccountWizard({ onSave, onClose, initialPlatforms }: { onSave: (account: Account) => Promise<void>; onClose: () => void; initialPlatforms?: Platform[] }) {
  const [step, setStep] = useState<Step>('details');
  const [chosen, setChosen] = useState<Platform[]>(initialPlatforms ?? PLATFORMS.map((platform) => platform.id));
  const [idea, setIdea] = useState('');
  const [label, setLabel] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [website, setWebsite] = useState('');
  const [signupEmail, setSignupEmail] = useState(DEFAULT_SIGNUP_EMAIL);
  const [imagePath, setImagePath] = useState('');
  const [preview, setPreview] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [current, setCurrent] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [windowId, setWindowId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setPreview(''); if (imagePath) loadImagePreview(imagePath).then(setPreview).catch(() => setPreview('')); }, [imagePath]);
  const ordered = PLATFORMS.map((platform) => platform.id).filter((id) => chosen.includes(id));
  const tightest = sharedBioLimit(ordered);
  const bioTooLong = bio.trim().length > tightest.limit;
  const account = accounts[current];
  const name = account ? getPlatform(account.platform).name : '';

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  const suggest = () => run(async () => {
    const suggestion = await suggestProfile(idea.trim(), tightest.limit, ordered.map((id) => getPlatform(id).name));
    setLabel(suggestion.name); setHandle(suggestion.username); setDisplayName(suggestion.displayName); setBio(suggestion.description);
    setNote('Suggested by your local model. Edit anything you like.');
  });
  function toggle(platform: Platform) { setChosen((list) => list.includes(platform) ? list.filter((item) => item !== platform) : [...list, platform]); }
  async function pickImage() { await run(async () => { const path = await chooseImageFile(); if (path) setImagePath(path); }); }
  async function openSignup(target: Account) {
    const id = await openPlatformWindow(target.platform, 'create');
    setWindowId(id);
    await fillSiteForm(id, formFieldsFor(target), { accountId: target.id, includePassword: true, keepFilling: true });
  }

  function start(event: FormEvent) {
    event.preventDefault();
    if (!label.trim() || !ordered.length || bioTooLong) return;
    void run(async () => {
      const made = ordered.map((platform): Account => ({ ...createAccount(platform, label, handle, 'planned', ''), displayName: displayName.trim(), bio: bio.trim(), website: website.trim(), signupEmail: signupEmail.trim(), imagePath }));
      for (const item of made) await onSave(item);
      setAccounts(made);
      await ensureSharedPassword(made.map((item) => item.id));
      setCurrent(0);
      await openSignup(made[0]);
      setStep('signup');
    });
  }
  const refill = (code?: string) => run(async () => {
    if (!account || !windowId) return;
    await fillSiteForm(windowId, formFieldsFor(account, code), { accountId: account.id, includePassword: !code, keepFilling: true });
    setNote(code ? `Entered code ${code}. Check it, then press the button on the page.` : 'Filled the empty fields on the current page.');
  });
  const reopen = () => run(async () => { if (account) await openSignup(account); });
  const showPassword = () => run(async () => { if (account) setPassword(await revealAccountPassword(account.id)); });
  const copyPassword = () => run(async () => {
    if (!account) return;
    await navigator.clipboard.writeText(password || await revealAccountPassword(account.id));
    setNote('Password copied.');
  });
  const advance = (outcome: Outcome) => run(async () => {
    if (!account) return;
    if (outcome === 'created') {
      const active = { ...account, status: 'active' as const };
      await onSave(active);
      setAccounts((list) => list.map((item) => item.id === active.id ? active : item));
    }
    setOutcomes((map) => ({ ...map, [account.id]: outcome }));
    const next = current + 1;
    if (next < accounts.length) { setCurrent(next); await openSignup(accounts[next]); }
    else setStep('profile');
  });
  const fillProfile = (target: Account) => run(async () => {
    const updated = { ...target, imagePath };
    if (imagePath !== target.imagePath) { await onSave(updated); setAccounts((list) => list.map((item) => item.id === updated.id ? updated : item)); }
    const id = await openPlatformWindow(target.platform, 'manage');
    setWindowId(id);
    await fillSiteForm(id, formFieldsFor(updated), { imagePath: imagePath || undefined, accountId: target.id, keepFilling: true });
    setNote(`Opened ${getPlatform(target.platform).name} profile settings and filled what matched. Check it, then save on the page.`);
  });
  const created = accounts.filter((item) => outcomes[item.id] === 'created');

  return <div className="modal-backdrop"><section className="dialog wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
    <div className="dialog-header"><div><p className="greeting">Guided sign-up</p><h2 id="wizard-title">Create accounts</h2></div><button className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><Close size={20}/></button></div>
    <div className="wizard-steps" aria-hidden="true">{STEPS.map((item, index) => <span key={item} className={STEPS.indexOf(step) >= index ? 'done' : ''}/>)}</div>

    {step === 'details' && <form onSubmit={start}>
      <p className="dialog-copy">Fill this in once. Socialspace makes one strong password and walks you through sign-up on each social with the same details. You press every button and handle any captcha.</p>
      <fieldset className="platform-picks"><legend>Socials</legend>{PLATFORMS.map((item) => <label key={item.id}><input type="checkbox" checked={chosen.includes(item.id)} onChange={() => toggle(item.id)}/> {item.name}</label>)}</fieldset>
      <label htmlFor="wizard-idea">Your idea <span>optional, the assistant suggests a name and description</span></label>
      <div className="idea-row"><input id="wizard-idea" maxLength={500} value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="e.g. handmade butterfly jewelry for kids"/><button type="button" className="outline-button" disabled={busy || !idea.trim() || !ordered.length} onClick={() => void suggest()}><Sparkles size={15}/> {busy ? 'Thinking…' : 'Suggest'}</button></div>
      <label htmlFor="wizard-name">Account name</label>
      <input id="wizard-name" autoFocus required maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Soft Wings Studio"/>
      <label htmlFor="wizard-handle">Username you want <span>optional</span></label>
      <input id="wizard-handle" maxLength={120} value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@softwings"/>
      <label htmlFor="wizard-display">Display name <span>optional</span></label>
      <input id="wizard-display" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)}/>
      <label htmlFor="wizard-bio">Profile description <span className={`bio-count ${bioTooLong ? 'over' : ''}`}>{bio.trim().length}/{tightest.limit}{ordered.length > 1 ? ` (${getPlatform(tightest.platform).name} limit)` : ''}</span></label>
      <textarea id="wizard-bio" rows={3} maxLength={1000} value={bio} onChange={(event) => setBio(event.target.value)}/>
      <label htmlFor="wizard-website">Website <span>optional</span></label>
      <input id="wizard-website" maxLength={300} value={website} onChange={(event) => setWebsite(event.target.value)}/>
      <label htmlFor="wizard-email">Sign-up email</label>
      <input id="wizard-email" type="email" required maxLength={320} value={signupEmail} onChange={(event) => setSignupEmail(event.target.value)}/>
      <label>Profile image <span>optional, you can add it later</span></label>
      <div className="profile-image">{preview && <img src={preview} alt="Profile preview"/>}<span>{imagePath ? imagePath.split(/[\\/]/).pop() : 'No image chosen'}</span><button type="button" className="outline-button" disabled={busy} onClick={() => void pickImage()}><ImagePlus size={15}/> Choose</button></div>
      {note && <p className="success-message" role="status">{note}</p>}
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !label.trim() || !signupEmail.trim() || !ordered.length || bioTooLong}><AppWindow size={15}/> {busy ? 'Opening…' : `Start with ${ordered.length} ${ordered.length === 1 ? 'social' : 'socials'}`}</button></div>
    </form>}

    {step === 'signup' && account && <>
      <ol className="social-progress">{accounts.map((item, index) => <li key={item.id} className={index === current ? 'current' : outcomes[item.id] ?? ''}>{getPlatform(item.platform).name}{outcomes[item.id] === 'created' ? ' ✓' : outcomes[item.id] === 'skipped' ? ' (skipped)' : ''}</li>)}</ol>
      <h3 className="wizard-now">Now: {name} ({current + 1} of {accounts.length})</h3>
      <ol>
        <li>The {name} sign-up window is open with your details filled in.</li>
        <li>Check each page, then press Next or Sign up yourself. New pages fill in automatically.</li>
        <li>When {name} emails a code to {account.signupEmail}, open the email below and copy it or fill it on the page.</li>
        <li>Handle any captcha, birthday, or phone check yourself.</li>
      </ol>
      <div className="password-row">Shared password: <code>{password || '••••••••••••••••••••'}</code><button type="button" className="icon-button" aria-label="Show password" onClick={() => void showPassword()}><Eye size={16}/></button><button type="button" className="icon-button" aria-label="Copy password" onClick={() => void copyPassword()}><Copy size={16}/></button></div>
      <div className="wizard-actions"><button type="button" className="outline-button" disabled={busy} onClick={() => void refill()}><RefreshCw size={14}/> Fill this page again</button><button type="button" className="outline-button" disabled={busy} onClick={() => void reopen()}><AppWindow size={14}/> Reopen {name} sign-up</button></div>
      <InboxList compact limit={8} onCode={(code) => void refill(code)}/>
      {note && <p className="success-message" role="status">{note}</p>}
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="outline-button" disabled={busy} onClick={() => void advance('skipped')}><SkipForward size={15}/> Skip {name}</button><button type="button" className="primary-button" disabled={busy} onClick={() => void advance('created')}><Check size={15}/> {name} account is created{current + 1 < accounts.length ? ', next' : ''}</button></div>
    </>}

    {step === 'profile' && <>
      <p className="dialog-copy">{created.length ? `Created on ${created.map((item) => getPlatform(item.platform).name).join(', ')}.` : 'No accounts were marked as created.'} Add the profile picture and description now, or later from Accounts. Skipped socials stay saved as planned.</p>
      <label>Profile image</label>
      <div className="profile-image">{preview && <img src={preview} alt="Profile preview"/>}<span>{imagePath ? imagePath.split(/[\\/]/).pop() : 'No image chosen'}</span><button type="button" className="outline-button" disabled={busy} onClick={() => void pickImage()}><ImagePlus size={15}/> Choose</button></div>
      <div className="wizard-actions">{created.map((item) => <button key={item.id} type="button" className="outline-button" disabled={busy} onClick={() => void fillProfile(item)}><AppWindow size={14}/> Fill {getPlatform(item.platform).name} profile</button>)}</div>
      {note && <p className="success-message" role="status">{note}</p>}
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="primary-button" disabled={busy} onClick={onClose}>Done</button></div>
    </>}
  </section></div>;
}
