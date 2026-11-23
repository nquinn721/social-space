import { AppWindow, Check, ChevronDown, Copy, ExternalLink, KeyRound, Link2, Loader2, Pencil, Plus, RefreshCw, Send, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { brandLogin, openPasswordReset, openProfilePage, saveResetPassword, wrongLogin } from './brandWindowService';
import { sharesLogins } from './brands';
import { useBrandStatuses, type SocialStatus } from './brandStatus';
import { getPlatform, normalizeHandle, PLATFORMS, type Account, type Brand, type Platform, type View, type Workspace } from './model';
import { PasswordCell } from './SignIns';
import { useAyrshare } from './useAyrshare';
import { BrandMark, errorText } from './ui';

/** Something the brand page asks this tab to do for one social, e.g. its "Link Instagram" chip. */
export type AccountRequest = { platform: Platform; kind: 'link' | 'view'; at: number };

type Props = {
  workspace: Workspace;
  brand: Brand;
  /** This brand's profiles, in platform order. */
  accounts: Account[];
  loaded: boolean;
  busy: boolean;
  onEditAccount: (account: Account) => void;
  /** Opens the social's sign-up page with this profile's details filled in. */
  onSignUp?: (account: Account) => void;
  onAlreadyCreated?: (account: Account) => void;
  onRemoveAccount?: (account: Account) => void;
  /** Adds this brand on another social and goes straight to its filled-in sign-up page. */
  onAddSocial?: (platform: Platform) => void;
  onNavigate?: (view: View, section?: string) => void;
  /** Why a social can't be added the usual way (e.g. its login is full), shown on the add button. */
  addHint?: (platform: Platform) => string;
  /** Problems that would stop this profile signing up, e.g. an email another account already uses. */
  warnings?: (account: Account) => string[];
  /** Run once when it changes: link or open one social straight away. */
  request?: AccountRequest;
};

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">Not set</span>;
  return <span className="copy-text" title={value}><span>{value}</span><button type="button" className="icon-button" aria-label={`Copy ${label}`} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => undefined)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></span>;
}

/**
 * The brand's posting on Ayrshare in one panel: connect Ayrshare, give the brand its Ayrshare profile, link
 * its socials. Every step is one button, and what it shows comes from Ayrshare itself.
 */
function BrandPosting({ brand, statuses, disabled, onNavigate }: { brand: Brand; statuses: SocialStatus[]; disabled: boolean; onNavigate?: (view: View, section?: string) => void }) {
  const ayrshare = useAyrshare();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pasting, setPasting] = useState(false);
  const [profileKey, setProfileKey] = useState('');
  const status = ayrshare.status;
  const socials = ayrshare.brands[brand.id]?.socials;
  const own = statuses.filter((item) => item.kind !== 'no-profile' && item.kind !== 'not-created');
  const linked = own.filter((item) => item.canPost || item.kind === 'no-x-keys');
  const toLink = own.filter((item) => item.kind === 'not-linked' || item.kind === 'relink');

  async function run(action: () => Promise<void>, done?: string) {
    if (working) return;
    setWorking(true); setError(''); setNote('');
    try { await action(); if (done) setNote(done); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  function adopt(event: FormEvent) {
    event.preventDefault();
    if (!profileKey.trim()) return;
    void run(async () => { await ayrshare.adoptProfile(brand, profileKey.trim()); setProfileKey(''); setPasting(false); }, `${brand.name}'s Ayrshare profile is set. Link its socials next.`);
  }

  let line: string; let tone: 'ok' | 'todo' | 'checking' | 'problem'; let body: ReactNode = null;
  if (status === null) { line = 'Checking Ayrshare…'; tone = 'checking'; }
  else if (!status.connected || status.working === false) {
    tone = 'todo'; line = 'Posting goes through Ayrshare. Connect it once under Settings, then set up each brand here.';
    body = onNavigate ? <button type="button" className="primary-button small-button" onClick={() => onNavigate('settings', 'ayrshare')}><KeyRound size={14}/> Connect Ayrshare</button> : null;
  } else if (socials === undefined) { line = 'Asking Ayrshare which socials are linked…'; tone = 'checking'; }
  else if (socials === null) {
    tone = 'problem'; line = `Ayrshare couldn't be asked about ${brand.name}${ayrshare.brands[brand.id]?.error ? `: ${ayrshare.brands[brand.id]?.error}` : '.'}`;
    body = <button type="button" className="outline-button small-button" disabled={working} onClick={() => void run(() => ayrshare.refreshBrand(brand.id))}><RefreshCw size={14}/> Check again</button>;
  } else if (!socials.hasProfile) {
    tone = 'todo'; line = `${brand.name} needs its own Ayrshare profile, where its socials get linked. One click makes it.`;
    body = <>
      <button type="button" className="primary-button small-button" disabled={disabled || working} onClick={() => void run(() => ayrshare.createProfile(brand), `${brand.name} has its Ayrshare profile. Link its socials next.`)}>{working ? <Loader2 size={14} className="spin"/> : <Send size={14}/>} Set up posting</button>
      <button type="button" className="ghost-button small-button" disabled={working} onClick={() => setPasting((value) => !value)}>Already have a profile key?</button>
    </>;
  } else {
    tone = toLink.length ? 'todo' : 'ok';
    line = own.length === 0 ? 'Ayrshare is set up. Create the brand\'s profiles on the socials, then link them here.'
      : toLink.length === 0 ? `Posting is set up: ${linked.map((item) => getPlatform(item.platform).name).join(', ')} ${linked.length === 1 ? 'is' : 'are'} linked on Ayrshare.`
      : `Link ${toLink.map((item) => getPlatform(item.platform).name).join(', ')} on Ayrshare. The page opens in ${brand.name}'s window with each login filled in; sign in and allow access.`;
    body = <>
      <button type="button" className={toLink.length ? 'primary-button small-button' : 'outline-button small-button'} disabled={disabled || working} onClick={() => void run(() => ayrshare.link(brand), 'The linking page is open. Links show up here a few seconds after you allow them.')}><Link2 size={14}/> {toLink.length ? 'Link socials' : 'Link another social'}</button>
      <button type="button" className="ghost-button small-button" disabled={working} aria-label="Check links again" onClick={() => void run(() => ayrshare.refreshBrand(brand.id))}><RefreshCw size={14}/> Check</button>
    </>;
  }
  return <div className={`brand-posting tone-${tone}`} aria-label={`${brand.name} posting`}>
    <div className="brand-posting-line"><Send size={15}/><span>{tone === 'checking' && <Loader2 size={13} className="spin"/>} {line}</span></div>
    {body && <div className="heading-buttons">{body}</div>}
    {pasting && socials && !socials.hasProfile && <form className="inline-add" onSubmit={adopt}>
      <label htmlFor={`profile-key-${brand.id}`} className="sr-only">Ayrshare profile key</label>
      <input id={`profile-key-${brand.id}`} type="password" autoComplete="off" spellCheck={false} placeholder="Paste the brand's Ayrshare profile key" value={profileKey} onChange={(event) => setProfileKey(event.target.value)}/>
      <button className="primary-button small-button" disabled={working || !profileKey.trim()}>Use it</button>
    </form>}
    {note && <p className="footnote" role="status">{note}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </div>;
}

/**
 * A brand's profiles as one compact list: its posting on Ayrshare first, then each social on one line with
 * where it stands (created, its own login, linked on Ayrshare) and the one button that moves it on. Sign-in
 * details are one click away under Details. Socials the brand isn't on yet are one click to add.
 */
export default function BrandAccounts({ workspace, brand, accounts, loaded, busy, onEditAccount, onSignUp, onAlreadyCreated, onRemoveAccount, onAddSocial, onNavigate, addHint, warnings, request }: Props) {
  const ayrshare = useAyrshare();
  const statuses = useBrandStatuses(workspace, brand.id);
  const [pageNote, setPageNote] = useState('');
  const [opening, setOpening] = useState<Record<string, boolean>>({});
  const openingNow = useRef(new Set<string>());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** A password reset waiting for Nate to say it worked, per profile. */
  const [resetting, setResetting] = useState<Record<string, boolean>>({});
  const rows = useRef<Record<string, HTMLLIElement | null>>({});
  const missing = PLATFORMS.filter((platform) => !accounts.some((account) => account.platform === platform.id));
  const disabled = !loaded || busy;

  /** The profile's public page, in a Social Space window signed in as the brand or in the default browser. */
  async function viewProfile(account: Account, inBrowser: boolean) {
    if (openingNow.current.has(account.id)) return;
    openingNow.current.add(account.id);
    setOpening((current) => ({ ...current, [account.id]: true }));
    try { await openProfilePage({ platform: account.platform, brandId: brand.id, ...brandLogin(account), handle: account.handle, inBrowser }); }
    catch (reason) { setPageNote(errorText(reason, `Could not open the ${getPlatform(account.platform).name} profile.`)); }
    finally {
      openingNow.current.delete(account.id);
      setOpening((current) => ({ ...current, [account.id]: false }));
    }
  }
  async function link() {
    setPageNote('');
    try { await ayrshare.link(brand); setPageNote('The linking page is open. Links show up here a few seconds after you allow them.'); }
    catch (reason) { setPageNote(errorText(reason)); }
  }
  async function reset(account: Account) {
    setPageNote('');
    try {
      await openPasswordReset({ platform: account.platform, brandId: brand.id, accountId: account.id, handle: account.handle, email: account.signupEmail ?? '' });
      setResetting((current) => ({ ...current, [account.id]: true }));
      setOpen((current) => ({ ...current, [account.id]: true }));
    } catch (reason) { setPageNote(errorText(reason)); }
  }
  async function keepReset(account: Account) {
    try { await saveResetPassword(account.id); setResetting((current) => ({ ...current, [account.id]: false })); setPageNote(`New ${getPlatform(account.platform).name} password saved.`); }
    catch (reason) { setPageNote(errorText(reason)); }
  }

  // The brand page's chips ("Link Instagram") act here straight away.
  const handled = useRef(0);
  useEffect(() => {
    if (!request || request.at === handled.current || !loaded) return;
    handled.current = request.at;
    const account = accounts.find((item) => item.platform === request.platform && item.status === 'active');
    if (account) rows.current[account.id]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    if (request.kind === 'link') void link();
    else if (account) void viewProfile(account, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, loaded]);

  /** The one button that moves a social on, from its status. */
  function actionOf(status: SocialStatus, account: Account): (() => void) | undefined {
    switch (status.action?.kind) {
      case 'finish-signup': return onSignUp ? () => onSignUp(account) : undefined;
      case 'own-login': return () => onEditAccount(account);
      case 'connect-ayrshare': case 'x-keys': return onNavigate ? () => onNavigate('settings', 'ayrshare') : undefined;
      case 'setup-posting': return () => void ayrshare.createProfile(brand).catch((reason) => setPageNote(errorText(reason)));
      case 'link': return () => void link();
      default: return undefined;
    }
  }

  return <section className="card brand-accounts" aria-label={`${brand.name} profiles`}>
    <div className="brand-accounts-head"><h3>Socials</h3><small>One line per social. Details has the sign-in.</small></div>
    <BrandPosting brand={brand} statuses={statuses} disabled={disabled} onNavigate={onNavigate}/>
    {pageNote && <div className="notice conn-notice" role="status"><span>{pageNote}</span><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setPageNote('')}>×</button></div>}
    <ul className="social-rows">{accounts.map((account) => {
      const name = getPlatform(account.platform).name;
      const live = account.status === 'active';
      const status = statuses.find((item) => item.platform === account.platform && item.account?.id === account.id)
        ?? statuses.find((item) => item.platform === account.platform)!;
      const run = status ? actionOf(status, account) : undefined;
      // Rows only repeat the brand-wide Ayrshare steps on the panel above, so they keep them quiet.
      const brandWide = status?.kind === 'no-ayrshare' || status?.kind === 'no-brand-profile';
      const expanded = Boolean(open[account.id]);
      const extra = warnings?.(account) ?? [];
      const tone = status?.tone ?? 'muted';
      return <li key={account.id} ref={(element) => { rows.current[account.id] = element; }} className={`social-row tone-${tone === 'ready' ? 'ok' : tone}`} aria-label={`${name} profile`}>
        <div className="social-row-main">
          <BrandMark platform={account.platform}/>
          <div className="social-row-title">
            <strong>{name}</strong>
            <small>{account.handle ? `@${normalizeHandle(account.handle)}` : 'No username yet'}</small>
          </div>
          <span className="status-chip" title={status?.detail}>{tone === 'checking' ? <Loader2 size={12} className="spin"/> : <span className="dot"/>}{status?.label}</span>
          <span className="social-row-actions">
            {status?.action && run && !brandWide && <button type="button" className="primary-button small-button" disabled={disabled || opening[account.id]} onClick={run}>{status.action.label}</button>}
            {live && account.handle && <button type="button" className="outline-button small-button" disabled={opening[account.id]} aria-label={`View ${name} profile`} title={`Opens @${normalizeHandle(account.handle)} on ${name} in a Social Space window signed in as ${brand.name}`} onClick={() => void viewProfile(account, false)}><AppWindow size={14}/> View</button>}
            <button type="button" className="ghost-button small-button" aria-expanded={expanded} aria-label={`${name} details`} onClick={() => setOpen((current) => ({ ...current, [account.id]: !expanded }))}>Details <ChevronDown size={14} className={expanded ? 'flip' : ''}/></button>
          </span>
        </div>
        {[status && !brandWide && status.kind !== 'ready' && status.tone !== 'checking' ? status.detail : '', ...extra].filter(Boolean).map((text) => <p key={text} className="social-row-note"><TriangleAlert size={12}/> {text}</p>)}
        {resetting[account.id] && <div className="social-row-reset" role="status">
          <span>Reset your {name} password in the window that opened (the email and a new password are filled in). Did it work?</span>
          <button type="button" className="primary-button small-button" onClick={() => void keepReset(account)}><Check size={13}/> It worked, save it</button>
          <button type="button" className="ghost-button small-button" onClick={() => setResetting((current) => ({ ...current, [account.id]: false }))}>Cancel</button>
        </div>}
        {expanded && <div className="social-row-details">
          <dl className="profile-signin" aria-label={`${name} sign-in`}>
            {!sharesLogins(account.platform) && account.handle && <div><dt>Username</dt><dd><CopyValue value={account.handle} label={`${name} username`}/></dd></div>}
            <div><dt>Email</dt><dd><CopyValue value={account.signupEmail ?? ''} label={`${name} email`}/></dd></div>
            <div><dt>{account.platform === 'youtube' ? 'Google password' : 'Password'}</dt><dd><PasswordCell account={account}/></dd></div>
          </dl>
          {account.platform === 'youtube' && <p className="footnote">YouTube signs in with your Google account. The window only fills the password saved here, so if Google says it's wrong, change it here to your real Google password.</p>}
          <div className="social-row-links">
            {live && account.handle && <button type="button" className="ghost-button small-button" disabled={opening[account.id]} onClick={() => void viewProfile(account, true)}><ExternalLink size={14}/> Open in browser</button>}
            {live && account.platform !== 'youtube' && account.platform !== 'x' && !wrongLogin(account) && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={() => void reset(account)}><KeyRound size={14}/> Reset password</button>}
            <button type="button" className="ghost-button small-button" disabled={disabled} onClick={() => onEditAccount(account)}><Pencil size={14}/> Edit details</button>
            {!live && onAlreadyCreated && <button type="button" className="ghost-button small-button" disabled={disabled} aria-label="Mark it live" title="Made it on the social yourself? Mark it live" onClick={() => onAlreadyCreated(account)}><Check size={14}/> Mark it live</button>}
            {!live && onRemoveAccount && <button type="button" className="ghost-button small-button danger-text" disabled={disabled} aria-label={`Delete ${name} profile`} onClick={() => onRemoveAccount(account)}><Trash2 size={14}/> Delete</button>}
          </div>
        </div>}
      </li>;
    })}</ul>
    {onAddSocial && missing.length > 0 && <div className="add-socials">{missing.map((platform) => <button type="button" key={platform.id} className="outline-button small-button" disabled={disabled} title={addHint?.(platform.id) || (platform.id === 'x' ? 'Open X sign-up and enter details yourself.' : `Opens ${platform.name} sign-up with ${brand.name}'s details filled in.`)} onClick={() => onAddSocial(platform.id)}>
      <Plus size={14}/> Add {platform.name}
    </button>)}</div>}
  </section>;
}
