import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, MailSearch, Pencil } from 'lucide-react';
import { listDeveloperApps, saveDeveloperApp, saveProductionApp, type DevAppSummary, type DevProvider } from './devAppsService';
import { DEFAULT_SIGNUP_EMAIL } from './CreateAccountWizard';
import { PasswordField } from './SignIns';
import { BrandMark, errorText } from './ui';
import { getPlatform, type Platform } from './model';
import { postMode } from './postingMode';
import { NO_REVIEW, REVIEW_STATES, reviewOf, reviewStatus, stateLabel, testModeOf, type ReviewState } from './appReviews';
import type { ReviewWatch } from './useReviewWatch';
import './brands.css';

/** The developer-site accounts behind each social's API app: one per social, on the main email, not a brand's. */
export const DEVELOPER_ACCOUNTS: { provider: DevProvider; platform: Platform; name: string; keys: [string, string] }[] = [
  { provider: 'tiktok', platform: 'tiktok', name: 'TikTok for Developers', keys: ['Client key', 'Client secret'] },
  { provider: 'google', platform: 'youtube', name: 'Google Cloud (YouTube)', keys: ['Client ID', 'Client secret'] },
  { provider: 'x', platform: 'x', name: 'X Developer', keys: ['Client ID', 'Client secret'] },
  { provider: 'meta', platform: 'instagram', name: 'Meta for Developers', keys: ['App ID', 'App secret'] },
];

/** Where a developer account's password is kept in Credential Manager, beside the profile passwords. */
export function developerPasswordKey(provider: DevProvider) { return `developer-${provider}`; }

/** marks: the workspace's setup marks, where review states are kept; onSet saves a state chosen by hand. */
export type ReviewProps = { marks?: Record<string, number>; onSet: (provider: DevProvider, state: ReviewState) => void; watch?: ReviewWatch; busy?: boolean };

const dayText = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function ReviewRow({ provider, reviews }: { provider: DevProvider; reviews?: ReviewProps }) {
  if (NO_REVIEW.includes(provider)) return <div><dt>Review</dt><dd><span className="review-pill approved">None needed</span></dd></div>;
  const review = reviewOf(provider);
  if (!review || !reviews) return null;
  const { state, at } = reviewStatus(reviews.marks, provider);
  const optional = review.optional && state === 'not-submitted';
  return <div className="review-row"><dt>Review</dt><dd>
    {optional ? <span className="review-pill approved" title={review.optional}>Not needed for your accounts</span>
      : <span className={`review-pill ${state}`} title={review.unlocks}>{review.name}{at ? ` · ${dayText(at)}` : ''}</span>}
    <select aria-label={`${review.name} status`} value={state} disabled={reviews.busy} onChange={(event) => reviews.onSet(provider, event.target.value as ReviewState)}>
      {REVIEW_STATES.map((item) => <option key={item.id} value={item.id}>{item.id === 'not-submitted' && review.optional ? 'Not submitted (optional)' : item.label}</option>)}
    </select>
    {optional && <small className="muted">{review.optional}</small>}
  </dd></div>;
}

/** The test-mode notice on a developer account, and its production keys saved ahead (TikTok Sandbox). */
function TestMode({ provider, platform, productionId, reviews, onSaved }: { provider: DevProvider; platform: Platform; productionId?: string | null; reviews?: ReviewProps; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [note, setNote] = useState('');
  const review = reviews ? testModeOf(reviews.marks, platform) : null;
  if (!review?.test) return null;
  async function save(event: FormEvent) {
    event.preventDefault();
    try { await saveProductionApp(provider, id.trim(), secret.trim()); setOpen(false); setId(''); setSecret(''); setNote('Production keys saved. They go into use when you press Switch after approval.'); onSaved(); }
    catch (reason) { setNote(errorText(reason)); }
  }
  return <div className="test-mode-box" role="note">
    <p><span className="test-badge">Test · {review.test.mode}</span> {review.test.limits}</p>
    {review.productionKeys && <>
      <p className="muted">{productionId ? <>Production keys saved ahead ({productionId}). Once {review.name} is approved, one click switches to them.</> : <>Save the production keys now, and one click switches to them once {review.name} is approved.</>}</p>
      {open ? <form className="developer-keys" onSubmit={(event) => void save(event)}>
        <label htmlFor={`prod-id-${provider}`}>Production client key</label>
        <input id={`prod-id-${provider}`} autoComplete="off" value={id} onChange={(event) => setId(event.target.value)}/>
        <label htmlFor={`prod-secret-${provider}`}>Production client secret</label>
        <input id={`prod-secret-${provider}`} type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)}/>
        <div className="row-actions"><button className="primary-button small-button" disabled={!id.trim()}>Save production keys</button><button type="button" className="ghost-button small-button" onClick={() => setOpen(false)}>Cancel</button></div>
      </form> : <button type="button" className="ghost-button small-button" onClick={() => setOpen(true)}><KeyRound size={14}/> {productionId ? 'Change production keys' : 'Add production keys'}</button>}
    </>}
    {note && <small role="status">{note}</small>}
  </div>;
}

function DeveloperCard({ account, app, onSaved, reviews }: { account: typeof DEVELOPER_ACCOUNTS[number]; app?: DevAppSummary; onSaved: () => void; reviews?: ReviewProps }) {
  const appId = app?.id ?? null;
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [idLabel, secretLabel] = account.keys;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !id.trim()) return;
    setSaving(true); setNote('');
    try { await saveDeveloperApp(account.provider, id.trim(), secret.trim()); setEditing(false); setId(''); setSecret(''); setNote('Keys saved.'); onSaved(); }
    catch (reason) { setNote(errorText(reason)); }
    finally { setSaving(false); }
  }
  const test = reviews ? testModeOf(reviews.marks, account.platform) : null;
  const review = reviewOf(account.provider);
  const reviewState = reviews && review ? reviewStatus(reviews.marks, account.provider).state : null;
  const browser = postMode(account.platform) === 'browser';
  return <div className="developer-account" aria-label={account.name}>
    <header className="developer-head">
      <BrandMark platform={account.platform}/>
      <div><h3>{account.name}</h3><small>{browser ? 'Only for API posting later' : `Needed to post on ${getPlatform(account.platform).name}`}</small></div>
      <span className={`status-chip ${appId ? 'tone-ok' : browser ? 'tone-muted' : 'tone-todo'}`}><span className="dot"/>{appId ? (test?.test ? `Keys saved · ${test.test.mode}` : 'Keys saved') : 'No keys yet'}</span>
    </header>
    <dl>
      <div><dt>Email</dt><dd><CopyValue value={DEFAULT_SIGNUP_EMAIL} label={`${account.name} email`}/></dd></div>
      <div><dt>Password</dt><dd><PasswordField id={developerPasswordKey(account.provider)} label={account.name}/></dd></div>
      <div><dt>{idLabel}</dt><dd>{appId ? <CopyValue value={appId} label={`${account.name} ${idLabel}`}/> : <span className="muted">Not saved yet</span>}</dd></div>
      {NO_REVIEW.includes(account.provider) && <ReviewRow provider={account.provider} reviews={reviews}/>}
    </dl>
    {review && !NO_REVIEW.includes(account.provider) && reviews && <details className="developer-more">
      <summary>App review{reviewState && <span className={`review-pill ${reviewState}`}>{stateLabel(reviewState)}</span>}</summary>
      <dl><ReviewRow provider={account.provider} reviews={reviews}/></dl>
      <TestMode provider={account.provider} platform={account.platform} productionId={app?.productionId} reviews={reviews} onSaved={onSaved}/>
    </details>}
    {editing ? <form className="developer-keys" onSubmit={(event) => void save(event)}>
      <label htmlFor={`dev-id-${account.provider}`}>{idLabel}</label>
      <input id={`dev-id-${account.provider}`} autoComplete="off" value={id} onChange={(event) => setId(event.target.value)}/>
      <label htmlFor={`dev-secret-${account.provider}`}>{secretLabel}</label>
      <input id={`dev-secret-${account.provider}`} type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)}/>
      <div className="row-actions"><button className="primary-button small-button" disabled={saving || !id.trim()}>{saving ? 'Saving…' : 'Save keys'}</button><button type="button" className="ghost-button small-button" onClick={() => setEditing(false)}>Cancel</button></div>
    </form> : <button type="button" className="ghost-button small-button developer-keys-button" onClick={() => { setEditing(true); setId(appId ?? ''); }}>{appId ? <><Pencil size={14}/> Change keys</> : <><KeyRound size={14}/> Add keys</>}</button>}
    {note && <small role="status">{note}</small>}
  </div>;
}

/** A value with a copy button on one line; long values are cut with … and shown whole on hover. */
function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <span className="copy-line" title={value}><span>{value}</span><button type="button" className="icon-button" aria-label={`Copy ${label}`} onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined)}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button></span>;
}

/** Settings section: each social's developer account (email, password) and its app keys, kept apart from brand profiles. */
export default function DeveloperAccounts({ reviews }: { reviews?: ReviewProps } = {}) {
  const [apps, setApps] = useState<Partial<Record<DevProvider, DevAppSummary>>>({});
  const [error, setError] = useState('');
  const load = () => { listDeveloperApps().then((list) => setApps(Object.fromEntries(list.map((app) => [app.provider, app])))).catch((reason) => setError(errorText(reason))); };
  useEffect(load, []);
  return <section className="settings-card" id="developer-accounts">
    <h2><KeyRound size={17}/> Developer accounts</h2>
    <p>The accounts that own each social's API app, on your main email, separate from the brand profiles. Only Meta's is needed to post today; the others matter once TikTok, YouTube or X post through their API. Passwords and secrets stay in Windows Credential Manager.</p>
    {reviews?.watch && <div className="status-line review-watch"><MailSearch size={15}/><span>{reviews.watch.note || `The app reads softwings25@gmail.com every 15 minutes for app review results and tells you when one finishes.${reviews.watch.lastChecked ? ` Last checked ${new Date(reviews.watch.lastChecked).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` : ''}`}</span><button type="button" className="ghost-button small-button" disabled={reviews.watch.checking} onClick={() => void reviews.watch?.checkNow()}>{reviews.watch.checking ? 'Checking…' : 'Check email now'}</button></div>}
    <div className="developer-accounts">{DEVELOPER_ACCOUNTS.map((account) => <DeveloperCard key={account.provider} account={account} app={apps[account.provider]} onSaved={load} reviews={reviews}/>)}</div>
    {error && <p className="error-message" role="alert">{error}</p>}
  </section>;
}
