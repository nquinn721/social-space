import { AppWindow, Check, ChevronDown, Copy, ExternalLink, KeyRound, Loader2, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { openPasswordReset, openProfilePage, saveResetPassword, type BrandSignIn } from './postingService';
import { useSignIns } from './useSignIns';
import { brandLogin, wrongLogin } from './useBrowserPosting';
import { sharesLogins } from './brands';
import { useEffect, useRef, useState } from 'react';
import { useConnectFlow } from './Connections';
import { getPlatform, normalizeHandle, PLATFORMS, type Account, type Brand, type DeveloperLogin, type Platform, type View } from './model';
import { canConnect } from './profileConnections';
import { setupNeeds, type Need } from './setupNeeds';
import { openSetupPage } from './setupService';
import { PasswordCell } from './SignIns';
import { postMode } from './postingMode';
import { BrandMark, errorText } from './ui';
import './setup.css';

/** Something the brand page asks this tab to do for one social, e.g. its "Connect Instagram" chip. */
export type AccountRequest = { platform: Platform; kind: 'connect' | 'sign-in'; at: number };

type Props = {
  brand: Brand;
  /** This brand's profiles, in platform order. */
  accounts: Account[];
  loaded: boolean;
  busy: boolean;
  /** Hand-ticked setup steps, saved in the workspace. */
  marks: Record<string, number>;
  onMark?: (id: string, done: boolean) => void;
  onEditAccount: (account: Account) => void;
  /** The developer accounts the app tracks (main email), and how to record one. */
  developerLogins?: Record<string, DeveloperLogin>;
  onDeveloperLogin?: (provider: string, email: string) => void;
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
  /** Run once when it changes: connect or sign in one social straight away. */
  request?: AccountRequest;
};

type Tone = 'ok' | 'todo' | 'problem' | 'muted' | 'checking';
/** One profile at a glance: a word or two, the one button that moves it on, and a line only when it needs one. */
type RowState = { tone: Tone; text: string; action?: { label: string; run: () => void }; note?: string };

/** What the brand's window folder is signed in as on this social, for the card. */
export function signInLine(platformName: string, handle: string, state: BrandSignIn | undefined): { tone: 'ok' | 'warning' | 'unknown'; text: string } {
  if (!state) return { tone: 'unknown', text: `Sign-in not checked yet. Open ${platformName} in Social Space once to check it.` };
  const at = new Date(state.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!state.signedIn) return { tone: 'warning', text: `Not signed in to ${platformName} (checked ${at}). Open it in Social Space and sign in once; it stays signed in.` };
  const own = normalizeHandle(handle).toLowerCase();
  if (state.handle && own && state.handle.toLowerCase() !== own) return { tone: 'warning', text: `Signed in as @${state.handle}, not @${normalizeHandle(handle)} (checked ${at}). Sign out in the window and sign in as @${normalizeHandle(handle)}.` };
  if (state.handle) return { tone: 'ok', text: `Signed in as @${state.handle} (checked ${at})` };
  return { tone: 'ok', text: `Signed in to ${platformName} (checked ${at})` };
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">Not set</span>;
  return <span className="copy-text" title={value}><span>{value}</span><button type="button" className="icon-button" aria-label={`Copy ${label}`} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => undefined)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></span>;
}

/**
 * A brand's profiles as one compact list: each social on one line with its real state (created, signed in,
 * connected) and the single button that moves it on. Sign-in details, links and setup steps are one click
 * away under Details. Socials the brand isn't on yet are one click to add.
 */
export default function BrandAccounts({ brand, accounts, loaded, busy, marks, onMark, onEditAccount, developerLogins, onDeveloperLogin, onSignUp, onAlreadyCreated, onRemoveAccount, onAddSocial, onNavigate, addHint, warnings, request }: Props) {
  const flow = useConnectFlow(accounts, [brand], { logins: developerLogins, onLogin: onDeveloperLogin });
  const { status, working, connect, disconnect } = flow;
  const [pageNote, setPageNote] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /** A password reset waiting for Nate to say it worked, per profile. */
  const [resetting, setResetting] = useState<Record<string, boolean>>({});
  const rows = useRef<Record<string, HTMLLIElement | null>>({});
  const signIns = useSignIns()[brand.id] ?? {};
  const groups = setupNeeds({ accounts, brands: [brand], apps: status.apps, connections: status.connections, passwords: status.passwords, marks, developerLogins });
  const needsOf = (account: Account) => groups.flatMap((group) => group.needs).filter((need) => need.accountId === account.id);
  // Steps on the social's developer side are shared by every brand, so they're only counted here.
  const appStepsLeft = (platform: Platform) => (groups.find((group) => group.platform === platform)?.needs ?? [])
    .filter((need) => !need.accountId && need.manual && !need.optional && !need.later && need.status === 'todo').length;
  const missing = PLATFORMS.filter((platform) => !accounts.some((account) => account.platform === platform.id));
  const disabled = !loaded || busy || working;

  /** The profile's public page, in a Social Space window signed in as the brand or in the default browser. */
  async function viewProfile(account: Account, inBrowser: boolean) {
    try { await openProfilePage({ platform: account.platform, brandId: brand.id, ...brandLogin(developerLogins, account), handle: account.handle, inBrowser }); }
    catch (reason) { setPageNote(errorText(reason, `Could not open the ${getPlatform(account.platform).name} profile.`)); }
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
    try { await saveResetPassword(account.id); setResetting((current) => ({ ...current, [account.id]: false })); setPageNote(`New ${getPlatform(account.platform).name} password saved. It syncs to your partner's app.`); }
    catch (reason) { setPageNote(errorText(reason)); }
  }

  // The brand page's chips ("Connect Instagram", "Sign in") act here straight away.
  const handled = useRef(0);
  useEffect(() => {
    if (!request || request.at === handled.current || !loaded) return;
    handled.current = request.at;
    const account = accounts.find((item) => item.platform === request.platform && item.status === 'active');
    if (!account) return;
    rows.current[account.id]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    if (request.kind === 'connect') void connect(account);
    else void viewProfile(account, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, loaded]);

  function rowState(account: Account): RowState {
    const name = getPlatform(account.platform).name;
    if (account.status !== 'active') return { tone: 'muted', text: 'Not created yet', action: onSignUp ? { label: `Create on ${name}`, run: () => onSignUp(account) } : undefined };
    if (wrongLogin(developerLogins, account)) return { tone: 'problem', text: 'Uses your main Gmail', action: { label: 'Fix login', run: () => onEditAccount(account) },
      note: `Posting windows won't sign in with your main Gmail. Give ${brand.name} its own ${name} email and password.` };
    if (postMode(account.platform) === 'api' && canConnect(account)) {
      const check = status.connections[account.id];
      const facebook = account.platform === 'facebook';
      if (working && flow.target === account.id) return { tone: 'checking', text: 'Waiting for Meta…', note: facebook ? 'Tick the brand\'s Page and press Continue in the Connect Facebook Page window.' : 'Sign in and press Allow in the Connect Instagram window.' };
      if (!check) return { tone: 'checking', text: 'Checking…' };
      // A Page has a name, not a handle, and is picked by the brand's name or the saved Page ID.
      if (facebook) {
        if (check.state === 'ok') return { tone: 'ok', text: 'Ready' };
        return { tone: 'todo', text: 'Not connected', action: { label: 'Connect', run: () => void connect(account) },
          note: 'Connect picks the Page named like the brand. Its Meta login configuration needs the Page permissions (see Details).' };
      }
      const as = normalizeHandle(check.username);
      if (check.state === 'ok' && as && account.handle && as.toLowerCase() !== normalizeHandle(account.handle).toLowerCase()) return { tone: 'problem', text: `Connected as @${as}`, action: { label: 'Reconnect', run: () => void connect(account) },
        note: `Meta connected @${as}, not @${normalizeHandle(account.handle)}, so posts would go to @${as}. Press Reconnect and pick @${normalizeHandle(account.handle)} in the Meta window. If it isn't listed, it isn't a Professional account linked to your Meta business yet.` };
      if (check.state === 'ok') return { tone: 'ok', text: 'Ready' };
      if (check.state === 'expired' || check.state === 'unchecked') return { tone: 'problem', text: 'Connection ran out', action: { label: 'Reconnect', run: () => void connect(account) }, note: check.detail || undefined };
      return { tone: 'todo', text: 'Not connected', action: { label: 'Connect', run: () => void connect(account) } };
    }
    const signIn = signIns[account.platform];
    const own = normalizeHandle(account.handle).toLowerCase();
    if (signIn && !signIn.signedIn) return { tone: 'todo', text: 'Not signed in', action: { label: 'Sign in', run: () => void viewProfile(account, false) },
      note: account.platform === 'youtube' ? undefined : `Sign in once and it stays signed in. If ${name} says the password is wrong, use Details, Reset password.` };
    if (signIn?.handle && own && signIn.handle.toLowerCase() !== own) return { tone: 'problem', text: `Signed in as @${signIn.handle}`, action: { label: 'Fix sign-in', run: () => void viewProfile(account, false) },
      note: `The ${brand.name} window is signed in to another account. Sign out there and sign in as @${normalizeHandle(account.handle)}.` };
    if (account.platform !== 'youtube' && status.passwords[account.id] === false) return { tone: 'todo', text: 'Login not saved', action: { label: 'Save login', run: () => onEditAccount(account) } };
    return { tone: 'ok', text: 'Ready' };
  }

  function stepRow(need: Need, who: string) {
    return <li key={need.id} className={`${need.status}${need.optional ? ' optional' : ''}`} aria-label={need.title}>
      <span className="check-circle">{need.status === 'problem' ? <TriangleAlert size={12} strokeWidth={3}/> : <Check size={13} strokeWidth={3}/>}</span>
      <div title={need.why}><strong>{need.title.startsWith(who) ? need.title.slice(who.length) : need.title}</strong></div>
      <span className="setup-actions">
        {need.page && <button type="button" className="ghost-button small-button" onClick={() => openSetupPage(need.page!.id).catch((reason) => setPageNote(errorText(reason)))}><ExternalLink size={13}/> {need.page.label}</button>}
        {onMark && <button type="button" className="outline-button small-button" disabled={disabled} onClick={() => onMark(need.id, true)}><Check size={13}/> Done</button>}
      </span>
    </li>;
  }

  const panelsHere = (account: Account) => flow.hasPanels && flow.target === account.id;
  return <section className="card brand-accounts" aria-label={`${brand.name} profiles`}>
    <div className="brand-accounts-head"><h3>Accounts</h3><small>One line per social. Details has the sign-in and links.</small></div>
    {flow.hasPanels && !accounts.some(panelsHere) && flow.panels}
    {pageNote && <div className="notice conn-notice" role="status"><span>{pageNote}</span><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setPageNote('')}>×</button></div>}
    <ul className="social-rows">{accounts.map((account) => {
      const name = getPlatform(account.platform).name;
      const live = account.status === 'active';
      const check = status.connections[account.id];
      const state = rowState(account);
      const who = `${brand.name}${account.handle ? ` (@${account.handle})` : ''}: `;
      const steps = live && !(postMode(account.platform) === 'api' && check?.state === 'ok') ? needsOf(account).filter((need) => need.manual && need.status !== 'done' && !need.optional) : [];
      const appLeft = live ? appStepsLeft(account.platform) : 0;
      const expanded = Boolean(open[account.id]);
      const extra = warnings?.(account) ?? [];
      return <li key={account.id} ref={(element) => { rows.current[account.id] = element; }} className={`social-row tone-${state.tone}`} aria-label={`${name} profile`}>
        <div className="social-row-main">
          <BrandMark platform={account.platform}/>
          <div className="social-row-title">
            <strong>{name}</strong>
            <small>{account.platform === 'facebook' ? (check?.state === 'ok' && check.username ? `Page: ${check.username}` : account.displayName || account.label || 'No Page yet') : account.handle ? `@${normalizeHandle(account.handle)}` : 'No username yet'}</small>
          </div>
          <span className="status-chip">{state.tone === 'checking' ? <Loader2 size={12} className="spin"/> : <span className="dot"/>}{state.text}</span>
          <span className="social-row-actions">
            {state.action && <button type="button" className="primary-button small-button" disabled={disabled} onClick={state.action.run}>{state.action.label}</button>}
            {live && account.handle && <button type="button" className="outline-button small-button" aria-label={`View ${name} profile`} title={`Opens @${normalizeHandle(account.handle)} on ${name} in a Social Space window signed in as ${brand.name}`} onClick={() => void viewProfile(account, false)}><AppWindow size={14}/> View</button>}
            <button type="button" className="ghost-button small-button" aria-expanded={expanded} aria-label={`${name} details`} onClick={() => setOpen((current) => ({ ...current, [account.id]: !expanded }))}>Details <ChevronDown size={14} className={expanded ? 'flip' : ''}/></button>
          </span>
        </div>
        {[state.note, ...extra].filter(Boolean).map((text) => <p key={text} className="social-row-note"><TriangleAlert size={12}/> {text}</p>)}
        {panelsHere(account) && <div className="social-row-panel">{flow.panels}</div>}
        {resetting[account.id] && <div className="social-row-reset" role="status">
          <span>Reset your {name} password in the window that opened (the email and a new password are filled in). Did it work?</span>
          <button type="button" className="primary-button small-button" onClick={() => void keepReset(account)}><Check size={13}/> It worked, save it</button>
          <button type="button" className="ghost-button small-button" onClick={() => setResetting((current) => ({ ...current, [account.id]: false }))}>Cancel</button>
        </div>}
        {expanded && <div className="social-row-details">
          {account.platform === 'facebook' ? <p className="footnote">Facebook Pages have no login of their own: the Page sits under your own Facebook account, and the app posts Reels to it through Meta with the Page's own key, kept in Windows Credential Manager.</p>
          : <dl className="profile-signin" aria-label={`${name} sign-in`}>
            {!sharesLogins(account.platform) && account.handle && <div><dt>Username</dt><dd><CopyValue value={account.handle} label={`${name} username`}/></dd></div>}
            <div><dt>Email</dt><dd><CopyValue value={account.signupEmail ?? ''} label={`${name} email`}/></dd></div>
            <div><dt>{account.platform === 'youtube' ? 'Google password' : 'Password'}</dt><dd><PasswordCell account={account}/></dd></div>
          </dl>}
          {account.platform === 'youtube' && <p className="footnote">YouTube signs in with your Google account. The window only fills the password saved here, so if Google says it's wrong, change it here to your real Google password.</p>}
          <div className="social-row-links">
            {live && account.handle && <button type="button" className="ghost-button small-button" onClick={() => void viewProfile(account, true)}><ExternalLink size={14}/> Open in browser</button>}
            {live && account.platform !== 'youtube' && account.platform !== 'facebook' && !wrongLogin(developerLogins, account) && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={() => void reset(account)}><KeyRound size={14}/> Reset password</button>}
            <button type="button" className="ghost-button small-button" disabled={disabled} onClick={() => onEditAccount(account)}><Pencil size={14}/> Edit details</button>
            {live && check?.state === 'ok' && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={() => void disconnect(account)}>Disconnect</button>}
            {!live && onAlreadyCreated && <button type="button" className="ghost-button small-button" disabled={disabled} aria-label="Mark it live" title="Made it on the social yourself? Mark it live" onClick={() => onAlreadyCreated(account)}><Check size={14}/> Mark it live</button>}
            {!live && onRemoveAccount && <button type="button" className="ghost-button small-button danger-text" disabled={disabled} aria-label={`Delete ${name} profile`} onClick={() => onRemoveAccount(account)}><Trash2 size={14}/> Delete</button>}
          </div>
          {live && signIns[account.platform] && postMode(account.platform) === 'browser' && <p className="footnote" aria-label={`${name} window sign-in`}>{signInLine(name, account.handle, signIns[account.platform]).text}</p>}
          {(steps.length > 0 || appLeft > 0) && <ul className="setup-list profile-steps" aria-label={`${name} steps left`}>
            {steps.map((need) => stepRow(need, who))}
            {appLeft > 0 && <li className="todo app-steps"><span className="check-circle"><Check size={13} strokeWidth={3}/></span>
              <div title="Shared by every brand, like app review. Done once in Setup."><strong>{appLeft} one-time {name} app {appLeft === 1 ? 'step' : 'steps'} open</strong></div>
              <span className="setup-actions">{onNavigate && <button type="button" className="ghost-button small-button" onClick={() => onNavigate('accounts', 'setup')}>Open Setup</button>}</span></li>}
          </ul>}
        </div>}
      </li>;
    })}</ul>
    {onAddSocial && missing.length > 0 && <div className="add-socials">{missing.map((platform) => <button type="button" key={platform.id} className="outline-button small-button" disabled={disabled} title={addHint?.(platform.id) || `Opens ${platform.name} sign-up with ${brand.name}'s details and password filled in.`} onClick={() => onAddSocial(platform.id)}>
      <Plus size={14}/> Add {platform.name}
    </button>)}</div>}
  </section>;
}
