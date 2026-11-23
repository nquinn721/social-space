import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Loader2, RefreshCw, Send } from 'lucide-react';
import { ayrshareUsage, type AyrshareUsage } from './ayrshareService';
import { postingSettings } from './postQueue';
import type { Workspace } from './model';
import { useAyrshare } from './useAyrshare';
import './today.css';
import { errorText } from './ui';

type Props = { workspace?: Workspace; /** Goes to Brands or the Calendar. */ onGo?: (where: 'brands' | 'calendar') => void };

/**
 * Settings → Ayrshare: the one place posting is set up. Ayrshare's API key (Business plan, so each brand gets
 * its own Ayrshare profile), the X app keys X needs, and what the account is using: profiles, this month's
 * posts, posting times and the AI label. Linking each brand's socials is done on the brand's Socials tab.
 */
export default function AyrshareSettings({ workspace, onGo }: Props) {
  const ayrshare = useAyrshare();
  const status = ayrshare.status;
  const [key, setKey] = useState('');
  const [changing, setChanging] = useState(false);
  const [xKey, setXKey] = useState('');
  const [xSecret, setXSecret] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  async function run(action: () => Promise<void>, done?: string) {
    if (working) return;
    setWorking(true); setError(''); setNote('');
    try { await action(); if (done) setNote(done); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!key.trim()) return;
    void run(async () => { await ayrshare.saveKey(key); setKey(''); setChanging(false); }, 'Ayrshare is connected. Set up posting on each brand\'s Socials tab.');
  }
  function saveX(event: FormEvent) {
    event.preventDefault();
    if (!xKey.trim() || !xSecret.trim()) return;
    void run(async () => { await ayrshare.saveXKeys(xKey, xSecret); setXKey(''); setXSecret(''); }, 'X app keys saved. Link X again on each brand so it uses your app.');
  }
  const connected = Boolean(status?.connected);
  const accepted = connected && status?.working === true;
  const [usage, setUsage] = useState<AyrshareUsage | null>(null);
  useEffect(() => { if (accepted) ayrshareUsage().then(setUsage).catch(() => setUsage(null)); else setUsage(null); }, [accepted]);
  const times = workspace ? postingSettings(workspace).times : [];
  const brandProfiles = workspace?.brands.filter((brand) => brand.ayrshare).length ?? 0;
  const line = status === null ? 'Checking Ayrshare…'
    : !status.connected ? 'Not connected. Posting and scheduling need Ayrshare.'
    : status.working === false ? `Ayrshare doesn't accept the saved key${status.detail ? `: ${status.detail}` : '.'}`
    : status.working === null ? `Key saved, but Ayrshare couldn't be reached${status.detail ? ` (${status.detail})` : ''}.`
    : `Connected${status.account ? ` as ${status.account}` : ''}.`;

  return <section className="settings-card" id="ayrshare">
    <h2><Send size={17}/> Ayrshare</h2>
    <p>Every post goes out through <strong>Ayrshare</strong>: it uploads the video, posts it to each brand's Instagram, Facebook, TikTok, YouTube and X, and schedules it for later. Each brand gets its own Ayrshare profile (needs Ayrshare's Business plan), where you link that brand's accounts once.</p>
    <div className={`status-line ${connected && status?.working !== false ? '' : 'off'}`}><span className="dot"/><span>{line}</span>
      {connected && <button type="button" className="ghost-button small-button" disabled={working} onClick={() => void run(ayrshare.refresh)}><RefreshCw size={14}/> Check</button>}
    </div>

    {(!connected || changing) ? <form onSubmit={saveKey}>
      <p>In Ayrshare, open <strong>API Key</strong> in the dashboard, copy the key, and paste it here. It's checked with Ayrshare and kept in Windows Credential Manager.</p>
      <label htmlFor="ayrshare-key">Ayrshare API key</label>
      <input id="ayrshare-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder="Paste the API key"/>
      <div className="heading-buttons">
        <button className="primary-button" disabled={working || !key.trim()}>{working ? <Loader2 size={15} className="spin"/> : <KeyRound size={15}/>} Connect Ayrshare</button>
        {changing && <button type="button" className="ghost-button" onClick={() => { setChanging(false); setKey(''); }}>Cancel</button>}
      </div>
    </form> : <div className="heading-buttons">
      <button type="button" className="ghost-button small-button" disabled={working} onClick={() => setChanging(true)}>Change key</button>
      <button type="button" className="ghost-button small-button danger-text" disabled={working} onClick={() => { if (window.confirm('Disconnect Ayrshare? Nothing posts or schedules until you connect it again. Posts already scheduled in Ayrshare still go out.')) void run(ayrshare.disconnect); }}>Disconnect</button>
    </div>}

    {accepted && <dl className="settings-facts">
      <div><dt>Profiles</dt><dd>{usage?.profiles ?? brandProfiles} {(usage?.profiles ?? brandProfiles) === 1 ? 'profile' : 'profiles'} · one per brand{onGo && <button type="button" className="text-button" onClick={() => onGo('brands')}>Manage on Brands</button>}</dd></div>
      <div><dt>Posts this month</dt><dd>{usage ? <><span className="usage-bar" aria-hidden="true"><span style={{ width: `${usage.quota ? Math.min(100, (usage.posts / usage.quota) * 100) : 0}%` }}/></span>{usage.posts.toLocaleString()}{usage.quota ? ` of ${usage.quota.toLocaleString()}` : ''}</> : 'Checking…'}</dd></div>
      <div><dt>Updates from Ayrshare</dt><dd>Post states every 5 minutes; results and comments every 30 minutes, while the app is open</dd></div>
      {times.length > 0 && <div><dt>Posting times</dt><dd>{times.join(', ')}, at most 3 a day per social{onGo && <button type="button" className="text-button" onClick={() => onGo('calendar')}>Change</button>}</dd></div>}
      <div><dt>AI label</dt><dd>Always on: YouTube, TikTok, Instagram and X get their AI label; Facebook and X get #AIgenerated</dd></div>
    </dl>}

    {connected && <form onSubmit={saveX}>
      <h3>X (Twitter)</h3>
      <p>X only takes posts made with your own X developer app, and X bills them (about 2¢ a post with a video, from credits you buy in the X Developer Console). In the X app, set read and write access and the callback URLs https://profile.ayrshare.com/social-accounts and https://app.ayrshare.com/social-accounts, then paste its API key and secret.</p>
      <div className={`status-line ${status?.xKeys ? '' : 'off'}`}><span className="dot"/><span>{status?.xKeys ? 'X app keys saved.' : 'No X app keys yet, so X posts are skipped.'}</span>
        {status?.xKeys && <button type="button" className="ghost-button small-button" disabled={working} onClick={() => void run(ayrshare.removeXKeys)}>Remove</button>}</div>
      <div className="field-row">
        <div><label htmlFor="x-key">X API key</label><input id="x-key" type="password" autoComplete="off" spellCheck={false} value={xKey} onChange={(event) => setXKey(event.target.value)}/></div>
        <div><label htmlFor="x-secret">X API key secret</label><input id="x-secret" type="password" autoComplete="off" spellCheck={false} value={xSecret} onChange={(event) => setXSecret(event.target.value)}/></div>
      </div>
      <button className="outline-button" disabled={working || !xKey.trim() || !xSecret.trim()}>Save X app keys</button>
    </form>}
    {note && <p className="footnote" role="status">{note}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
