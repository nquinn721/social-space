import { useState } from 'react';
import { Check, ClipboardCheck, ExternalLink, TriangleAlert } from 'lucide-react';
import type { DevProvider } from './devAppsService';
import { openCount, platformName, setupNeeds, type Need, type SetupInputs } from './setupNeeds';
import { openSetupPage } from './setupService';
import type { Account } from './model';
import { BrandMark, errorText } from './ui';
import './setup.css';

type Props = SetupInputs & {
  /** Saves a manual tick (or clears it). Without it the manual steps are read-only. */
  onMark?: (id: string, done: boolean) => void;
  onConnect?: (account: Account) => void;
  onSetupApp?: (provider: DevProvider) => void;
  onEditAccount?: (account: Account) => void;
  working?: boolean;
  /** Shown above the list, e.g. which brand this is for. */
  scope?: string;
};

const dateText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** A checklist of everything still needed before the app can post, per social and per profile. */
export default function SetupTracker({ onMark, onConnect, onSetupApp, onEditAccount, working = false, scope, ...inputs }: Props) {
  const [showDone, setShowDone] = useState(false);
  const [note, setNote] = useState('');
  const groups = setupNeeds(inputs);
  const left = openCount(groups);
  if (groups.length === 0) return null;

  const row = (need: Need) => <li key={need.id} className={`${need.status}${need.optional ? ' optional' : ''}`} aria-label={need.title}>
            <span className="check-circle">{need.status === 'problem' ? <TriangleAlert size={12} strokeWidth={3}/> : <Check size={13} strokeWidth={3}/>}</span>
            <div>
              <strong>{need.title}{need.optional && <span className="setup-tag">optional</span>}</strong>
              <small>{need.status === 'checking' ? 'Checking…' : need.why}</small>
              {need.manual && need.markedAt && <small className="setup-marked">Ticked {dateText(need.markedAt)}</small>}
            </div>
            <span className="setup-actions">
              {need.page && need.status !== 'done' && <button type="button" className="ghost-button small-button" onClick={() => openSetupPage(need.page!.id).catch((reason) => setNote(errorText(reason)))}><ExternalLink size={13}/> {need.page.label}</button>}
              {actionButton(need)}
              {need.manual && onMark && (need.status === 'done'
                ? <button type="button" className="ghost-button small-button" disabled={working} onClick={() => onMark(need.id, false)}>Undo</button>
                : <button type="button" className="outline-button small-button" disabled={working} onClick={() => onMark(need.id, true)}>Mark done</button>)}
            </span>
          </li>;
  function actionButton(need: Need) {
    const action = need.action;
    if (!action || need.status === 'done' || need.status === 'checking') return null;
    if (action.kind === 'connect' && onConnect) return <button type="button" className="primary-button small-button" disabled={working} onClick={() => onConnect(action.account)}>{need.status === 'problem' ? 'Reconnect' : 'Connect'}</button>;
    if (action.kind === 'setup-app' && onSetupApp) return <button type="button" className="primary-button small-button" disabled={working} onClick={() => onSetupApp(action.provider)}>Set up</button>;
    if (action.kind === 'sign-in' && onEditAccount) return <button type="button" className="outline-button small-button" disabled={working} onClick={() => onEditAccount(action.account)}>Add sign-in</button>;
    return null;
  }

  return <section className="card setup-tracker" aria-label="What's needed to post">
    <div className="conn-card-head">
      <div><h3><ClipboardCheck size={15}/> What's needed to post{scope ? ` for ${scope}` : ''}</h3>
        <small>{left === 0 ? 'Everything needed to post is done.' : `${left} ${left === 1 ? 'step' : 'steps'} left. Steps the app can see check themselves; tick the rest when they're done.`}</small></div>
      <label className="check-row setup-show-done"><input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)}/> Show finished</label>
    </div>
    {note && <div className="notice conn-notice" role="status"><span>{note}</span><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNote('')}>×</button></div>}
    {groups.map((group) => {
      const now = group.needs.filter((need) => !need.later);
      const later = group.needs.filter((need) => need.later && (showDone || need.status !== 'done'));
      const shown = now.filter((need) => showDone || need.status !== 'done');
      return <div className="setup-group" key={group.platform} aria-label={`${platformName(group.platform)} setup`} role="group">
        <div className="setup-group-head"><BrandMark platform={group.platform} small/><strong>{platformName(group.platform)}</strong>
          <span className={`pill ${group.open ? 'warning' : 'active'}`}><span className="dot"/>{group.open ? `${group.open} left` : 'Ready'}</span>{group.testing && <span className="pill testing" title="Posts reach only test users and stay private until the app is approved."><span className="dot"/>{group.testing}</span>}</div>
        {shown.length === 0 ? <p className="footnote setup-all-done">{now.length ? 'All done. Tick "Show finished" to see every step.' : 'Nothing needed: it posts through its own upload page.'}</p>
          : <ul className="setup-list">{shown.map(row)}</ul>}
        {later.length > 0 && <details className="setup-later"><summary>For API posting later <small>{later.filter((need) => need.status !== 'done').length} open · not needed to post through its upload page</small></summary>
          <ul className="setup-list">{later.map(row)}</ul></details>}
      </div>;
    })}
  </section>;
}
