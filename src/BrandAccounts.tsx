import { AppWindow, Check, Copy, ExternalLink, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { openProfilePage } from './postingService';
import { brandLogin, wrongLogin } from './useBrowserPosting';
import { useState } from 'react';
import { useConnectFlow } from './Connections';
import { getPlatform, normalizeHandle, PLATFORMS, type Account, type Brand, type DeveloperLogin, type Platform, type View } from './model';
import { canConnect } from './profileConnections';
import { setupNeeds, type Need } from './setupNeeds';
import { openSetupPage } from './setupService';
import { PasswordCell } from './SignIns';
import { postMode } from './postingMode';
import { BrandMark, errorText } from './ui';
import './setup.css';

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
};

/** What a profile shows at a glance: one word, and the one thing to do next. */
type Readiness = { tone: 'active' | 'planned' | 'warning'; text: string };

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">Not set</span>;
  return <span className="copy-text"><span>{value}</span><button type="button" className="icon-button" aria-label={`Copy ${label}`} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => undefined)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></span>;
}

/**
 * A brand's profiles, one card each: whether it's live and connected, its sign-in, and the steps it
 * still needs, each with a single button. Socials the brand isn't on yet are one click to add.
 */
export default function BrandAccounts({ brand, accounts, loaded, busy, marks, onMark, onEditAccount, developerLogins, onDeveloperLogin, onSignUp, onAlreadyCreated, onRemoveAccount, onAddSocial, onNavigate, addHint, warnings }: Props) {
  const flow = useConnectFlow(accounts, [brand], { logins: developerLogins, onLogin: onDeveloperLogin });
  const { status, working, connect, disconnect } = flow;
  const [pageNote, setPageNote] = useState('');
  const groups = setupNeeds({ accounts, brands: [brand], apps: status.apps, connections: status.connections, passwords: status.passwords, marks, developerLogins });
  const needsOf = (account: Account) => groups.flatMap((group) => group.needs).filter((need) => need.accountId === account.id);
  // Steps on the social's developer side are shared by every brand, so they're only counted here.
  const appStepsLeft = (platform: Platform) => (groups.find((group) => group.platform === platform)?.needs ?? [])
    .filter((need) => !need.accountId && need.manual && !need.optional && !need.later && need.status === 'todo').length;
  const missing = PLATFORMS.filter((platform) => !accounts.some((account) => account.platform === platform.id));
  const disabled = !loaded || busy || working;

  function readiness(account: Account): Readiness {
    if (account.status !== 'active') return { tone: 'planned', text: 'Not created yet' };
    const check = status.connections[account.id];
    // TikTok, YouTube and X post through their own page in the brand's window: no API connection needed.
    if (postMode(account.platform) === 'browser') {
      if (wrongLogin(developerLogins, account)) return { tone: 'warning', text: 'Uses your main Gmail' };
      if (account.platform !== 'youtube' && status.passwords[account.id] === false) return { tone: 'warning', text: 'Ready · login not saved' };
      return { tone: 'active', text: 'Ready to post' };
    }
    if (!canConnect(account)) return { tone: 'active', text: 'Live' };
    if (!check) return { tone: 'planned', text: 'Live · checking…' };
    if (check.state === 'expired' || check.state === 'unchecked') return { tone: 'warning', text: 'Live · reconnect needed' };
    if (check.state === 'none') return { tone: 'warning', text: 'Live · not connected' };
    const open = needsOf(account).filter((need) => need.manual && !need.optional && need.status === 'todo').length;
    return open ? { tone: 'warning', text: `Connected · ${open} ${open === 1 ? 'step' : 'steps'} left` } : { tone: 'active', text: 'Ready to post' };
  }

  function stepRow(need: Need, who: string) {
    return <li key={need.id} className={`${need.status}${need.optional ? ' optional' : ''}`} aria-label={need.title}>
      <span className="check-circle">{need.status === 'problem' ? <TriangleAlert size={12} strokeWidth={3}/> : <Check size={13} strokeWidth={3}/>}</span>
      {/* The longer why stays a hover away, so each card reads as a short checklist. */}
      <div title={need.why}><strong>{need.title.startsWith(who) ? need.title.slice(who.length) : need.title}{need.optional && <span className="setup-tag">optional</span>}</strong></div>
      <span className="setup-actions">
        {need.page && <button type="button" className="ghost-button small-button" onClick={() => openSetupPage(need.page!.id).catch((reason) => setPageNote(errorText(reason)))}><ExternalLink size={13}/> {need.page.label}</button>}
        {onMark && <button type="button" className="outline-button small-button" disabled={disabled} onClick={() => onMark(need.id, true)}><Check size={13}/> Done</button>}
      </span>
    </li>;
  }

  /** The profile's public page, in a Social Space window signed in as the brand or in the default browser. */
  async function viewProfile(account: Account, inBrowser: boolean) {
    try { await openProfilePage({ platform: account.platform, brandId: brand.id, ...brandLogin(developerLogins, account), handle: account.handle, inBrowser }); }
    catch (reason) { setPageNote(errorText(reason, `Could not open the ${getPlatform(account.platform).name} profile.`)); }
  }

  return <section className="brand-accounts" aria-label={`${brand.name} profiles`}>
    {flow.panels}
    {pageNote && <div className="notice conn-notice" role="status"><span>{pageNote}</span><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setPageNote('')}>×</button></div>}
    <div className="profile-cards">{accounts.map((account) => {
      const platformName = getPlatform(account.platform).name;
      const live = account.status === 'active';
      const check = status.connections[account.id];
      const connectedAs = check?.state === 'ok' ? normalizeHandle(check.username) : '';
      const state = readiness(account);
      const who = `${brand.name}${account.handle ? ` (@${account.handle})` : ''}: `;
      // The profile's own manual steps (account type, linked Page…); sign-in and connection have their own rows.
      const steps = needsOf(account).filter((need) => need.manual && need.status !== 'done');
      const appLeft = live ? appStepsLeft(account.platform) : 0;
      const needsConnect = live && postMode(account.platform) === 'api' && canConnect(account) && check && check.state !== 'ok';
      return <article key={account.id} className={`profile-card ${state.tone}`} aria-label={`${platformName} profile`}>
        <header className="profile-card-head">
          <BrandMark platform={account.platform}/>
          <div className="profile-card-title">
            <strong>{platformName}</strong>
            <small>{account.handle ? `@${account.handle}` : 'No username yet'}{connectedAs && connectedAs.toLowerCase() !== normalizeHandle(account.handle).toLowerCase() ? ` · connected as @${connectedAs}` : ''}</small>
          </div>
          <span className={`pill ${state.tone}`}><span className="dot"/>{state.text}</span>
          <span className="profile-card-actions">
            {!live && onSignUp && <button type="button" className="primary-button small-button" disabled={disabled} onClick={() => onSignUp(account)}>Create on {platformName}</button>}
            {needsConnect && <button type="button" className="primary-button small-button" disabled={disabled} onClick={() => void connect(account)}>{check.state === 'none' ? 'Connect' : 'Reconnect'}</button>}
            {live && check?.state === 'ok' && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={() => void disconnect(account)}>Disconnect</button>}
            <button type="button" className="icon-button" aria-label={`Edit ${platformName} profile`} title="Edit details" disabled={disabled} onClick={() => onEditAccount(account)}><Pencil size={15}/></button>
            {!live && onRemoveAccount && <button type="button" className="icon-button" aria-label={`Delete ${platformName} profile`} title="Delete this profile from the app" disabled={disabled} onClick={() => onRemoveAccount(account)}><Trash2 size={15}/></button>}
          </span>
        </header>
        {wrongLogin(developerLogins, account) && <p className="row-warning"><TriangleAlert size={12}/> Saved with your main Gmail, so posting and profile windows won't sign in with it. Give {brand.name} its own {platformName} email and password under Edit details.</p>}
        {warnings?.(account).map((text) => <p key={text} className="row-warning"><TriangleAlert size={12}/> {text}</p>)}
        {live && account.handle && <p className="profile-card-note profile-view">See the live videos:
          <button type="button" className="ghost-button small-button" onClick={() => void viewProfile(account, false)}><AppWindow size={14}/> Open in Social Space</button>
          <button type="button" className="ghost-button small-button" onClick={() => void viewProfile(account, true)}><ExternalLink size={14}/> Open in browser</button></p>}
        {!live && onAlreadyCreated && <p className="profile-card-note">Made it on {platformName} yourself? <button type="button" className="text-button" disabled={disabled} onClick={() => onAlreadyCreated(account)}>Mark it live</button></p>}
        <dl className="profile-signin" aria-label={`${platformName} sign-in`}>
          <div><dt>Email</dt><dd><CopyValue value={account.signupEmail ?? ''} label={`${platformName} email`}/></dd></div>
          <div><dt>Password</dt><dd><PasswordCell account={account}/></dd></div>
        </dl>
        {(steps.length > 0 || appLeft > 0) && <ul className="setup-list profile-steps" aria-label={`${platformName} steps left`}>
          {steps.map((need) => stepRow(need, who))}
          {appLeft > 0 && <li className="todo app-steps"><span className="check-circle"><Check size={13} strokeWidth={3}/></span>
            <div title="Shared by every brand, like app review. Done once in Setup."><strong>{appLeft} one-time {platformName} app {appLeft === 1 ? 'step' : 'steps'} open</strong></div>
            <span className="setup-actions">{onNavigate && <button type="button" className="ghost-button small-button" onClick={() => onNavigate('accounts', 'setup')}>Open Setup</button>}</span></li>}
        </ul>}
      </article>;
    })}
      {onAddSocial && missing.map((platform) => <button type="button" key={platform.id} className="profile-card add-social" disabled={disabled} title={addHint?.(platform.id)} onClick={() => onAddSocial(platform.id)}>
        <BrandMark platform={platform.id}/>
        <span><strong><Plus size={14}/> Add {platform.name}</strong><small>Opens {platform.name} sign-up with {brand.name}'s details and password filled in.</small></span>
      </button>)}
    </div>
  </section>;
}
