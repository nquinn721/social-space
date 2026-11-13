import { useEffect, useState, type FormEvent } from 'react';
import { Copy, KeyRound, MailSearch, Pencil } from 'lucide-react';
import { listDeveloperApps, saveDeveloperApp, type DevProvider } from './devAppsService';
import { DEFAULT_SIGNUP_EMAIL } from './CreateAccountWizard';
import { PasswordField } from './SignIns';
import { BrandMark, errorText } from './ui';
import type { Platform } from './model';
import { NO_REVIEW, REVIEW_STATES, reviewOf, reviewStatus, type ReviewState } from './appReviews';
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
  return <div className="review-row"><dt>Review</dt><dd>
    <span className={`review-pill ${state}`} title={review.unlocks}>{review.name}{at ? ` · ${dayText(at)}` : ''}</span>
    <select aria-label={`${review.name} status`} value={state} disabled={reviews.busy} onChange={(event) => reviews.onSet(provider, event.target.value as ReviewState)}>
      {REVIEW_STATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
  </dd></div>;
}

function DeveloperCard({ account, appId, onSaved, reviews }: { account: typeof DEVELOPER_ACCOUNTS[number]; appId: string | null; onSaved: () => void; reviews?: ReviewProps }) {
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
  return <div className="developer-account" aria-label={account.name}>
    <h3><BrandMark platform={account.platform}/> {account.name}</h3>
    <dl>
      <div><dt>Email</dt><dd><span className="copy-text"><span>{DEFAULT_SIGNUP_EMAIL}</span><button type="button" className="icon-button" aria-label={`Copy ${account.name} email`} onClick={() => void navigator.clipboard.writeText(DEFAULT_SIGNUP_EMAIL).catch(() => undefined)}><Copy size={14}/></button></span></dd></div>
      <div><dt>Password</dt><dd><PasswordField id={developerPasswordKey(account.provider)} label={account.name}/></dd></div>
      <div><dt>{idLabel}</dt><dd>{appId ? <span className="copy-text"><span>{appId}</span><button type="button" className="icon-button" aria-label={`Copy ${account.name} ${idLabel}`} onClick={() => void navigator.clipboard.writeText(appId).catch(() => undefined)}><Copy size={14}/></button></span> : <span className="muted">Not saved yet</span>}</dd></div>
      <ReviewRow provider={account.provider} reviews={reviews}/>
    </dl>
    {editing ? <form className="developer-keys" onSubmit={(event) => void save(event)}>
      <label htmlFor={`dev-id-${account.provider}`}>{idLabel}</label>
      <input id={`dev-id-${account.provider}`} autoComplete="off" value={id} onChange={(event) => setId(event.target.value)}/>
      <label htmlFor={`dev-secret-${account.provider}`}>{secretLabel}</label>
      <input id={`dev-secret-${account.provider}`} type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)}/>
      <div className="row-actions"><button className="primary-button small-button" disabled={saving || !id.trim()}>{saving ? 'Saving…' : 'Save keys'}</button><button type="button" className="ghost-button small-button" onClick={() => setEditing(false)}>Cancel</button></div>
    </form> : <button type="button" className="outline-button small-button" onClick={() => { setEditing(true); setId(appId ?? ''); }}>{appId ? <><Pencil size={14}/> Change keys</> : <><KeyRound size={14}/> Add keys</>}</button>}
    {note && <small role="status">{note}</small>}
  </div>;
}

/** Settings section: each social's developer account (email, password) and its app keys, kept apart from brand profiles. */
export default function DeveloperAccounts({ reviews }: { reviews?: ReviewProps } = {}) {
  const [apps, setApps] = useState<Partial<Record<DevProvider, string | null>>>({});
  const [error, setError] = useState('');
  const load = () => { listDeveloperApps().then((list) => setApps(Object.fromEntries(list.map((app) => [app.provider, app.id])))).catch((reason) => setError(errorText(reason))); };
  useEffect(load, []);
  return <section className="settings-card" id="developer-accounts">
    <h2><KeyRound size={17}/> Developer accounts</h2>
    <p>The accounts that own each social's API app, on the main email and separate from the brand profiles. Passwords and app secrets are kept in Windows Credential Manager.</p>
    {reviews?.watch && <div className="status-line review-watch"><MailSearch size={15}/><span>{reviews.watch.note || `The app reads softwings25@gmail.com every 15 minutes for app review results and tells you when one finishes.${reviews.watch.lastChecked ? ` Last checked ${new Date(reviews.watch.lastChecked).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` : ''}`}</span><button type="button" className="ghost-button small-button" disabled={reviews.watch.checking} onClick={() => void reviews.watch?.checkNow()}>{reviews.watch.checking ? 'Checking…' : 'Check email now'}</button></div>}
    <div className="developer-accounts">{DEVELOPER_ACCOUNTS.map((account) => <DeveloperCard key={account.provider} account={account} appId={apps[account.provider] ?? null} onSaved={load} reviews={reviews}/>)}</div>
    {error && <p className="error-message" role="alert">{error}</p>}
  </section>;
}
