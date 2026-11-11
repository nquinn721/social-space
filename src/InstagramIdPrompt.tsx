import { useState, type FormEvent } from 'react';
import { finishInstagramConnection } from './instagramService';
import { errorText } from './ui';

type Props = { profile: string; handle: string; onDone: (username: string) => void; onCancel: () => void };

/**
 * Shown when Meta approved the connection but would not say which Instagram account it is for.
 * The account ID from Meta Business Settings finishes it without signing in again.
 */
export default function InstagramIdPrompt({ profile, handle, onDone, onCancel }: Props) {
  const [id, setId] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working || !id.trim()) return;
    setWorking(true); setError('');
    try { onDone((await finishInstagramConnection(profile, id.trim())).username); }
    catch (reason) { setError(errorText(reason)); }
    finally { setWorking(false); }
  }
  return <form className="card backup-form" onSubmit={submit} aria-label="Finish connecting Instagram">
    <strong>One last step for @{handle}</strong>
    <small>Meta connected the app but would not say which Instagram account it is for. In Meta Business Settings, open <em>Accounts → Instagram accounts</em>, click the account, and copy the long number shown as its <em>ID</em>.</small>
    <label htmlFor="ig-account-id">Instagram account ID</label>
    <input id="ig-account-id" inputMode="numeric" autoComplete="off" value={id} onChange={(event) => setId(event.target.value)} placeholder="17841..."/>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="inline-add"><button className="primary-button small-button" disabled={working || !id.trim()}>{working ? 'Checking…' : 'Finish connecting'}</button><button type="button" className="ghost-button small-button" onClick={onCancel}>Cancel</button></div>
  </form>;
}
