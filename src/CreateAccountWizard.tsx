import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AppWindow, Check, ChevronRight, Copy, Eye, EyeOff, ImagePlus, RefreshCw, SkipForward, Sparkles, Wand2, X as Close } from 'lucide-react';
import { suggestProfile } from './assistant/suggest';
import { emailTag, planPresence } from './brands';
import { BIO_LIMITS, createAccount, getPlatform, normalizeHandle, PLATFORMS, type Account, type AccountProfile, type Platform } from './model';
import { chooseImageFile, openGmailSignup, closeEmbeddedPage, embedPlatformPage, ensureSharedPassword, fillSiteForm, formFieldsFor, revealAccountPassword, setEmbeddedBounds, type Bounds } from './profileService';
import InboxList from './InboxList';
import ProfileImageStudio, { type AutoImage } from './ProfileImageStudio';
import { BrandMark, errorText, initialOf, useImagePreview } from './ui';

/** All new accounts verify through this inbox unless changed in the form. */
export const DEFAULT_SIGNUP_EMAIL = 'softwings25@gmail.com';
/** Sign-up forms (TikTok, Instagram, X, Google) all ask for a birthday; brands use this one unless changed. */
export const DEFAULT_SIGNUP_BIRTHDAY = '1995-06-15';
/** Details to start the form with, e.g. when adding an existing brand to more socials. */
export type WizardPrefill = { label?: string; handle?: string; brandId?: string } & AccountProfile;
type Step = 'details' | 'signup' | 'profile';
const STEPS: { id: Step; label: string }[] = [{ id: 'details', label: 'Details' }, { id: 'signup', label: 'Sign up' }, { id: 'profile', label: 'Profile' }];
type Outcome = 'created' | 'skipped';
/** During sign-up the inbox checks often, so a new code is entered on the page within seconds. */
const SIGNUP_INBOX_MS = 6_000;
const SENDER_WORDS: Record<Platform, RegExp> = { instagram: /\binstagram\b/i, tiktok: /\btiktok\b/i, youtube: /\b(youtube|google)\b/i, x: /\bx(\.com)?\b|\btwitter\b/i };
/** Whether an email looks like it came from this social, so its code goes to the right sign-up page. */
export function isMailFrom(platform: Platform, mail: { from: string; subject: string }) { return SENDER_WORDS[platform].test(`${mail.from} ${mail.subject}`); }

/** The tightest description limit among the chosen socials, so one description fits them all. */
export function sharedBioLimit(platforms: Platform[]) {
  const limits = platforms.map((platform) => ({ platform, limit: BIO_LIMITS[platform] }));
  return limits.reduce((tightest, item) => item.limit < tightest.limit ? item : tightest, limits[0] ?? { platform: 'youtube' as Platform, limit: BIO_LIMITS.youtube });
}

/** A page to show in the wizard's site area. nonce makes "Reopen" load it again. */
type SitePage = { account: Account; action: 'create' | 'manage'; imagePath?: string; nonce: number };
function boundsOf(element: HTMLElement): Bounds {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height };
}

function ImagePicker({ path, preview, busy, onPick, onGenerated, suggestion, auto }: { path: string; preview: string; busy: boolean; onPick: () => void; onGenerated: (path: string) => void; suggestion: string; auto?: AutoImage }) {
  const [studio, setStudio] = useState(Boolean(auto));
  useEffect(() => { if (auto) setStudio(true); }, [auto?.key]);
  return <>
    <div className="profile-image">{preview ? <img src={preview} alt="Profile preview"/> : <span className="image-placeholder"><ImagePlus size={18}/></span>}<span>{path ? path.split(/[\\/]/).pop() : 'No image chosen'}</span><button type="button" className="outline-button small-button generate-button" disabled={busy} aria-expanded={studio} onClick={() => setStudio((open) => !open)}><Wand2 size={13}/> Generate</button><button type="button" className="outline-button small-button" disabled={busy} onClick={onPick}>Choose</button></div>
    {studio && <ProfileImageStudio key={auto?.key} suggestion={suggestion} auto={auto} onAutoUse={onGenerated} disabled={busy} onClose={() => setStudio(false)} onUse={(generated) => { onGenerated(generated); setStudio(false); }}/>}
  </>;
}

/**
 * Creates the same account on every chosen social, one sign-up at a time.
 * The social list comes from PLATFORMS, so a newly supported social is included automatically.
 * It only fills forms: Nate presses every button and solves any captcha himself.
 */
export default function CreateAccountWizard({ onSave, onClose, initialPlatforms, prefill, resume, existing = [] }: { onSave: (account: Account) => Promise<void>; onClose: () => void; initialPlatforms?: Platform[]; prefill?: WizardPrefill; resume?: Account[]; existing?: Account[] }) {
  const [step, setStep] = useState<Step>(resume?.length ? 'signup' : 'details');
  const [chosen, setChosen] = useState<Platform[]>(initialPlatforms ?? PLATFORMS.map((platform) => platform.id));
  const [idea, setIdea] = useState('');
  const [label, setLabel] = useState(prefill?.label ?? '');
  const [handle, setHandle] = useState(prefill?.handle ?? '');
  const [displayName, setDisplayName] = useState(prefill?.displayName ?? '');
  const [bio, setBio] = useState(prefill?.bio ?? '');
  const [website, setWebsite] = useState(prefill?.website ?? '');
  const [signupEmail, setSignupEmail] = useState(prefill?.signupEmail || DEFAULT_SIGNUP_EMAIL);
  const [imagePath, setImagePath] = useState(prefill?.imagePath ?? '');
  const [autoImage, setAutoImage] = useState<AutoImage>();
  const [birthday, setBirthday] = useState(prefill?.birthday || DEFAULT_SIGNUP_BIRTHDAY);
  const [page, setPage] = useState<SitePage | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [accounts, setAccounts] = useState<Account[]>(resume ?? []);
  const [current, setCurrent] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [windowId, setWindowId] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const preview = useImagePreview(imagePath);
  const ordered = PLATFORMS.map((platform) => platform.id).filter((id) => chosen.includes(id));
  const tightest = sharedBioLimit(ordered);
  // Left blank, the username and display name come from the account name, e.g. Massage With Mia → @massagewithmia.
  const shownName = displayName.trim() || label.trim();
  const shownHandle = normalizeHandle(handle) || (label.trim() ? emailTag(label) : '');
  // Each social either adds this brand to a login that has room, or gets a new account with an unused email.
  const plans = ordered.map((platform) => planPresence(existing, platform, label.trim() || handle || 'brand', signupEmail));
  const bioLength = bio.trim().length;
  const bioTooLong = bioLength > tightest.limit;
  const account = accounts[current];
  const name = account ? getPlatform(account.platform).name : '';
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy && step === 'details') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, step, onClose]);

  // The sign-up page is a real browser view placed over the site area of the wizard.
  useEffect(() => {
    const element = frame.current;
    if (!page || !element) return;
    let cancelled = false;
    setWindowId('');
    (async () => {
      try {
        const id = await embedPlatformPage(page.account.platform, page.action, boundsOf(element));
        if (cancelled) return;
        setWindowId(id);
        await fillSiteForm(id, formFieldsFor(page.account), page.action === 'create'
          ? { accountId: page.account.id, includePassword: true, keepFilling: true }
          : { imagePath: page.imagePath, accountId: page.account.id, keepFilling: true });
      } catch (reason) { if (!cancelled) setError(errorText(reason)); }
    })();
    return () => { cancelled = true; };
  }, [page]);
  useEffect(() => {
    const element = frame.current;
    if (!windowId || !element) return;
    const place = () => { void setEmbeddedBounds(windowId, boundsOf(element)).catch(() => undefined); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    window.addEventListener('resize', place);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); };
  }, [windowId]);
  useEffect(() => () => { void closeEmbeddedPage().catch(() => undefined); }, []);
  // Saved accounts that are not created yet go straight to their first sign-up page.
  useEffect(() => {
    if (!resume?.length) return;
    void run(async () => { await ensureSharedPassword(resume.map((item) => item.id)); openSignup(resume[0]); });
  }, []);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  const suggest = () => run(async () => {
    const suggestion = await suggestProfile(idea.trim(), tightest.limit, ordered.map((id) => getPlatform(id).name));
    setLabel(suggestion.name); setHandle(suggestion.username); setDisplayName(suggestion.displayName); setBio(suggestion.description);
    setAutoImage({ description: suggestion.imagePrompt || `${suggestion.name}, ${idea.trim()}`, style: suggestion.imageStyle, key: Date.now() });
    setNote('Suggested by Grok, and a matching profile picture is on its way. Edit anything you like.');
  });
  // Optional: a separate Gmail for the brand. Plus-addresses are simpler, since their codes reach the connected inbox.
  const makeGmail = () => run(async () => {
    const id = await openGmailSignup();
    const fields = { firstName: (displayName || label).trim(), username: emailTag(handle || label), birthday };
    await fillSiteForm(id, Object.fromEntries(Object.entries(fields).filter(([, value]) => value)), { keepFilling: true });
    setNote('Opened Google sign-up with the brand filled in. Finish it there, then put the new address in Sign-up email. Connect it under Settings to see its codes here.');
  });
  function toggle(platform: Platform) { setChosen((list) => list.includes(platform) ? list.filter((item) => item !== platform) : [...list, platform]); }
  const pickImage = () => run(async () => { const path = await chooseImageFile(); if (path) setImagePath(path); });
  function openSignup(target: Account) { setPage((last) => ({ account: target, action: 'create', nonce: (last?.nonce ?? 0) + 1 })); }

  function start(event: FormEvent) {
    event.preventDefault();
    if (!label.trim() || !ordered.length || bioTooLong) return;
    void run(async () => {
      const made = plans.map((plan): Account => ({ ...createAccount(plan.platform, label, shownHandle, 'planned', ''), displayName: shownName, bio: bio.trim(), website: website.trim(), signupEmail: plan.email, imagePath, birthday, ...(prefill?.brandId ? { brandId: prefill.brandId } : {}) }));
      for (const item of made) await onSave(item);
      setAccounts(made);
      await ensureSharedPassword(made.map((item) => item.id));
      setCurrent(0);
      setStep('signup');
      openSignup(made[0]);
    });
  }
  const refill = (code?: string) => run(async () => {
    if (!account || !windowId) return;
    await fillSiteForm(windowId, formFieldsFor(account, code), { accountId: account.id, includePassword: !code, keepFilling: true });
    setNote(code ? `Entered code ${code}. Check it, then press the button on the page.` : 'Filled the empty fields on the current page.');
  });
  const reopen = () => { if (account) openSignup(account); };
  const togglePassword = () => run(async () => { if (!account) return; if (!showPass && !password) setPassword(await revealAccountPassword(account.id)); setShowPass((value) => !value); });
  const copy = (what: string, value: string | (() => Promise<string>)) => run(async () => {
    await navigator.clipboard.writeText(typeof value === 'string' ? value : await value());
    setNote(`${what} copied.`);
  });
  const copyPassword = () => copy('Password', async () => password || (account ? revealAccountPassword(account.id) : ''));
  const advance = (outcome: Outcome) => run(async () => {
    if (!account) return;
    if (outcome === 'created') {
      const active = { ...account, status: 'active' as const };
      await onSave(active);
      setAccounts((list) => list.map((item) => item.id === active.id ? active : item));
    }
    setOutcomes((map) => ({ ...map, [account.id]: outcome }));
    const next = current + 1;
    if (next < accounts.length) { setCurrent(next); openSignup(accounts[next]); }
    else { setPage(null); setWindowId(''); await closeEmbeddedPage(); setStep('profile'); }
  });
  const fillProfile = (target: Account) => run(async () => {
    const updated = { ...target, imagePath };
    if (imagePath !== target.imagePath) { await onSave(updated); setAccounts((list) => list.map((item) => item.id === updated.id ? updated : item)); }
    setPage((last) => ({ account: updated, action: 'manage', imagePath: imagePath || undefined, nonce: (last?.nonce ?? 0) + 1 }));
    setNote(`Opened ${getPlatform(target.platform).name} profile settings and filled what matched. Check it, then save on the page.`);
  });
  const created = accounts.filter((item) => outcomes[item.id] === 'created');
  const feedback = <>{note && <p className="success-message" role="status">{note}</p>}{error && <div className="error-message" role="alert">{error}</div>}</>;
  const closeButton = <button type="button" className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><Close size={18}/></button>;


  return <div className="modal-backdrop"><section className={`dialog wizard ${step === 'details' ? '' : 'site-open'}`} role="dialog" aria-modal="true" aria-labelledby="wizard-title">
    <aside className="wizard-rail">
      <div><p className="greeting">Guided sign-up</p><h2 id="wizard-title">Create accounts</h2></div>
      <ol className="wizard-steps">{STEPS.map((item, index) => <li key={item.id} className={index === stepIndex ? 'current' : index < stepIndex ? 'done' : ''} aria-current={index === stepIndex ? 'step' : undefined}><span className="step-num">{index < stepIndex ? <Check size={12} strokeWidth={3}/> : index + 1}</span>{item.label}</li>)}</ol>
      {step !== 'details' && <ol className="social-progress" aria-label="Socials">{accounts.map((item, index) => {
        const outcome = outcomes[item.id];
        return <li key={item.id} className={step === 'signup' && index === current ? 'current' : outcome ?? ''}><BrandMark platform={item.platform} small/>{getPlatform(item.platform).name}<em>{outcome === 'created' ? 'Created' : outcome === 'skipped' ? 'Skipped' : step === 'signup' && index === current ? 'Now' : 'Next'}</em></li>;
      })}</ol>}
      <p className="rail-note">Social Space only fills in forms. You press every button and solve any captcha or phone check.</p>
    </aside>

    <div className="wizard-main">
      {step === 'details' && <form className="wizard-form" onSubmit={start}>
        <div className="wizard-top"><div><h3>Who's it for?</h3><p>Fill this in once. Every social gets the same details and one strong shared password.</p></div>{closeButton}</div>
        <div className="wizard-scroll">
          <fieldset className="platform-picks"><legend>Socials</legend>{PLATFORMS.map((item) => <label key={item.id} className="platform-pick"><input type="checkbox" aria-label={item.name} checked={chosen.includes(item.id)} onChange={() => toggle(item.id)}/><BrandMark platform={item.id} small/>{item.name}<span className="pick-check"><Check size={12} strokeWidth={3}/></span></label>)}</fieldset>
          <div className="idea-card">
            <label htmlFor="wizard-idea"><Sparkles size={15}/> Your idea <span>optional, the assistant suggests a name and description</span></label>
            <div className="idea-row"><input id="wizard-idea" maxLength={500} value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="e.g. handmade butterfly jewelry for kids" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (idea.trim() && ordered.length) void suggest(); } }}/><button type="button" className="primary-button" disabled={busy || !idea.trim() || !ordered.length} onClick={() => void suggest()}><Sparkles size={15}/> {busy ? 'Thinking…' : 'Suggest'}</button></div>
          </div>
          <div className="wizard-grid">
            <div>
              <label htmlFor="wizard-name">Account name</label>
              <input id="wizard-name" autoFocus required maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Soft Wings Studio"/>
              <div className="field-row">
                <div><label htmlFor="wizard-handle">Username you want <span>optional</span></label><input id="wizard-handle" maxLength={120} value={handle} onChange={(event) => setHandle(event.target.value)} placeholder={label.trim() ? `@${emailTag(label)}` : '@softwings'}/></div>
                <div><label htmlFor="wizard-display">Display name <span>optional</span></label><input id="wizard-display" maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={label.trim() || undefined}/></div>
              </div>
              <label htmlFor="wizard-bio">Profile description <span className={`bio-count ${bioTooLong ? 'over' : ''}`}>{bioLength}/{tightest.limit}{ordered.length > 1 ? ` (${getPlatform(tightest.platform).name} limit)` : ''}</span></label>
              <textarea id="wizard-bio" rows={3} maxLength={1000} value={bio} onChange={(event) => setBio(event.target.value)}/>
              <label htmlFor="wizard-website">Website <span>optional</span></label><input id="wizard-website" maxLength={300} value={website} onChange={(event) => setWebsite(event.target.value)}/>
              <details className="signin-details">
                <summary>Sign-in details <span>handled for you</span></summary>
                <div className="field-row">
                  <div><label htmlFor="wizard-email">Sign-up email</label><input id="wizard-email" type="email" required maxLength={320} value={signupEmail} onChange={(event) => setSignupEmail(event.target.value)}/></div>
                  <div><label htmlFor="wizard-birthday">Birthday <span>for sign-up forms that ask</span></label><input id="wizard-birthday" type="date" max={new Date().toISOString().slice(0, 10)} value={birthday} onChange={(event) => setBirthday(event.target.value)}/></div>
                </div>
                <p className="signin-hint">TikTok and X get their own address automatically, like you+brand@gmail.com, so no new inbox is needed. <button type="button" className="text-button" disabled={busy || !label.trim()} onClick={() => void makeGmail()}>Make a new Gmail instead</button></p>
                {signupEmail.trim() && plans.length > 0 && <ul className="login-plan" aria-label="Login plan">{plans.map((plan) => <li key={plan.platform}><BrandMark platform={plan.platform} small/><span>{plan.reason}</span></li>)}</ul>}
              </details>
              <label>Profile image <span>optional, you can add it later</span></label>
              <ImagePicker path={imagePath} preview={preview} busy={busy} onPick={() => void pickImage()} onGenerated={setImagePath} suggestion={idea.trim()} auto={autoImage}/>
              {feedback}
            </div>
            <aside className="preview-card" aria-label="Profile preview">
              <span className="label">Preview</span>
              <div className="preview-profile"><span className="avatar" aria-hidden="true">{preview ? <img src={preview} alt=""/> : initialOf(shownName, '?')}</span><div><strong>{shownName || 'Your name'}</strong><small>{shownHandle ? `@${shownHandle}` : '@username'}</small></div></div>
              <p className={`preview-bio ${bio.trim() ? '' : 'placeholder'}`}>{bio.trim() || 'Your description shows here.'}</p>
              {website.trim() && <p className="preview-link">{website.trim()}</p>}
              <ul className="limit-list" aria-label="Description limits">{ordered.map((platform) => {
                const limit = BIO_LIMITS[platform];
                return <li key={platform} className={bioLength > limit ? 'over' : ''}><BrandMark platform={platform} small/><span className="limit-bar"><span style={{ width: `${Math.min(100, (bioLength / limit) * 100)}%` }}/></span><em>{bioLength}/{limit}</em></li>;
              })}</ul>
            </aside>
          </div>
        </div>
        <div className="wizard-foot"><span className="foot-note">Profiles are saved as not created yet until you mark them created.</span><button type="button" className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !label.trim() || !signupEmail.trim() || !ordered.length || bioTooLong}><AppWindow size={15}/> {busy ? 'Opening…' : `Start with ${ordered.length} ${ordered.length === 1 ? 'social' : 'socials'}`}</button></div>
      </form>}

      {step !== 'details' && <>
        <div className="wizard-top">{step === 'signup' && account
          ? <div><h3 className="wizard-now"><BrandMark platform={account.platform}/><span>Now: {name} ({current + 1} of {accounts.length})</span></h3><p>Your details are filled in on the {name} page below. Check them, then press Next or Sign up on the page yourself.</p></div>
          : <div><h3>Finish the profiles</h3><p>{created.length ? `Created on ${created.map((item) => getPlatform(item.platform).name).join(', ')}.` : 'No accounts were marked as created.'} Add the picture and description now, or later from Accounts. Skipped socials stay saved as planned.</p></div>}{closeButton}</div>
        <div className="site-stage">
          <div ref={frame} className="site-frame" aria-label="Site page">{!windowId && <span>{page ? 'Loading the page…' : 'Pick a social on the right to open its profile settings here.'}</span>}</div>
          <aside className="site-side">
            {step === 'signup' && account && <>
              <ol className="signup-steps">
                <li>New pages fill in automatically as you press Next.</li>
                <li>When {name} emails a code to {account.signupEmail}, it's entered on the page for you within seconds. You can also press a code below.</li>
                <li>Solve any captcha or phone check yourself.</li>
              </ol>
              <section className="credentials copy-list" aria-label="Sign-up details">
                <h3>Sign-up details</h3>
                <div className="credential-row"><span>Email</span><code>{account.signupEmail}</code><button type="button" className="icon-button" aria-label="Copy email" onClick={() => void copy('Email', account.signupEmail ?? '')}><Copy size={15}/></button></div>
                {account.handle && <div className="credential-row"><span>Username</span><code>{account.handle}</code><button type="button" className="icon-button" aria-label="Copy username" onClick={() => void copy('Username', account.handle)}><Copy size={15}/></button></div>}
                <div className="credential-row"><span>Password</span><code>{showPass && password ? password : '••••••••••••••••'}</code><button type="button" className="icon-button" aria-label={showPass ? 'Hide password' : 'Show password'} onClick={() => void togglePassword()}>{showPass ? <EyeOff size={15}/> : <Eye size={15}/>}</button><button type="button" className="icon-button" aria-label="Copy password" onClick={() => void copyPassword()}><Copy size={15}/></button></div>
                {account.birthday && <div className="credential-row"><span>Birthday</span><code>{account.birthday}</code><button type="button" className="icon-button" aria-label="Copy birthday" onClick={() => void copy('Birthday', account.birthday ?? '')}><Copy size={15}/></button></div>}
              </section>
              <div className="wizard-actions"><button type="button" className="outline-button small-button" disabled={busy || !windowId} onClick={() => void refill()}><RefreshCw size={14}/> Fill this page again</button><button type="button" className="outline-button small-button" disabled={busy} onClick={reopen}><AppWindow size={14}/> Start {name} over</button></div>
              {feedback}
              <InboxList compact autoRefresh refreshMs={SIGNUP_INBOX_MS} limit={8} onCode={(code) => void refill(code)} onNewCode={(code, mail) => { if (isMailFrom(account.platform, mail)) void refill(code); }}/>
            </>}
            {step === 'profile' && <>
              <ul className="summary-list">{accounts.map((item) => <li key={item.id} className={outcomes[item.id] ?? ''}><BrandMark platform={item.platform} small/>{getPlatform(item.platform).name}<em>{outcomes[item.id] === 'created' ? 'Created' : 'Planned'}</em></li>)}</ul>
              <label>Profile image</label>
              <ImagePicker path={imagePath} preview={preview} busy={busy} onPick={() => void pickImage()} onGenerated={setImagePath} suggestion={idea.trim()}/>
              {created.length > 0 && <div className="profile-actions">{created.map((item) => <button key={item.id} type="button" className="outline-button" disabled={busy} onClick={() => void fillProfile(item)}><BrandMark platform={item.platform} small/> Fill {getPlatform(item.platform).name} profile <ChevronRight size={15}/></button>)}</div>}
              {feedback}
            </>}
          </aside>
        </div>
        {step === 'signup' && account
          ? <div className="wizard-foot"><button type="button" className="outline-button" disabled={busy} onClick={() => void advance('skipped')}><SkipForward size={15}/> Skip {name}</button><button type="button" className="primary-button" disabled={busy} onClick={() => void advance('created')}><Check size={15}/> {name} account is created{current + 1 < accounts.length ? ', next' : ''}</button></div>
          : <div className="wizard-foot"><button type="button" className="primary-button" disabled={busy} onClick={onClose}>Done</button></div>}
      </>}
    </div>
  </section></div>;
}
