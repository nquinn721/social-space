import { useEffect, useState } from 'react';
import { Clapperboard, Link2, Mail, RefreshCw } from 'lucide-react';
import { connectGmailSession, emailConnection, openGmailSignIn } from './emailService';
import { connectInstagramApp, INSTAGRAM_REDIRECT_URI, instagramConnection, saveInstagramApp } from './instagramService';
import { xConnection } from './xService';
import { listVideoSources } from './videoSourcesService';
import { normalizeHandle, type Account, type Platform, type View } from './model';
import { BrandMark, errorText } from './ui';

/** What the app is really connected to. null means not connected (or it could not be checked). */
export type ConnectionState = {
  inbox: string | null;
  instagram: string | null;
  x: string | null;
  videoSources: number;
};
const EMPTY: ConnectionState = { inbox: null, instagram: null, x: null, videoSources: 0 };
const settle = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);

/** Checks every connection once when shown, and again on refresh. */
export function useConnectionState() {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([
      settle(emailConnection().then((value) => value?.username ?? null), null),
      settle(instagramConnection().then((value) => value?.username ?? null), null),
      settle(xConnection().then((value) => value?.username ?? null), null),
      settle(listVideoSources().then((value) => value.sources.filter((source) => source.status === 'verified').length), 0),
    ]).then(([inbox, instagram, x, videoSources]) => { if (live) setState({ inbox, instagram, x, videoSources }); });
    return () => { live = false; };
  }, [tick]);
  return { state: state ?? EMPTY, loading: state === null, refresh: () => setTick((value) => value + 1) };
}

/** Whether the app can post for this profile: the connected account on its social is this profile's username. */
export function postingConnected(account: Account, state: ConnectionState) {
  const connected: Partial<Record<Platform, string | null>> = { instagram: state.instagram, x: state.x };
  const name = connected[account.platform];
  return Boolean(name && account.handle && normalizeHandle(name).toLowerCase() === normalizeHandle(account.handle).toLowerCase());
}

type Row = { key: string; icon: React.ReactNode; name: string; what: string; connected: string | null; go: () => void; connect?: () => void };

/** Everything the app signs in to, in one list: connected or not, and where to connect it. */
export default function Connections({ onNavigate, accounts = [] }: { onNavigate: (view: View, section?: string) => void; accounts?: Account[] }) {
  const { state, loading, refresh } = useConnectionState();
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState('');
  // One click: use the Gmail sign-in already in the app, or open Gmail to sign in once and connect when you come back.
  async function connectInbox() {
    if (working) return;
    setWorking(true); setNote('');
    try { await connectGmailSession(); refresh(); setNote('Inbox connected.'); }
    catch {
      try { await openGmailSignIn(); setNote('Sign in to Gmail in the window that opened, then press Connect again.'); }
      catch (reason) { setNote(errorText(reason)); }
    } finally { setWorking(false); }
  }
  // Instagram: one click opens Instagram's approval window with the profile's saved sign-in filled in.
  const instagramProfiles = accounts.filter((account) => account.platform === 'instagram' && account.status === 'active');
  const [igProfile, setIgProfile] = useState('');
  const [setup, setSetup] = useState(false);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  async function connectInstagram() {
    if (working) return;
    const profile = instagramProfiles.find((account) => account.id === igProfile) ?? instagramProfiles[0];
    setWorking(true); setNote('');
    try {
      const identity = await connectInstagramApp(profile?.id ?? null, profile?.handle ?? null);
      setSetup(false); refresh(); setNote(`Instagram connected as @${identity.username}.`);
    } catch (reason) {
      const text = errorText(reason);
      if (text === 'SETUP_NEEDED') { setSetup(true); setNote(''); } else setNote(text);
    } finally { setWorking(false); }
  }
  async function saveApp(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true); setNote('');
    try { await saveInstagramApp(appId, appSecret); setAppSecret(''); setWorking(false); await connectInstagram(); }
    catch (reason) { setNote(errorText(reason)); setWorking(false); }
  }
  const rows: Row[] = [
    { key: 'inbox', icon: <span className="connection-icon"><Mail size={16}/></span>, name: 'Email inbox', what: 'Reads sign-up codes so they fill in by themselves.', connected: state.inbox, go: () => onNavigate('settings', 'email'), connect: () => void connectInbox() },
    { key: 'instagram', icon: <BrandMark platform="instagram" small/>, name: 'Instagram posting', what: 'Lets the app post Reels and photos for one Instagram profile.', connected: state.instagram && `@${normalizeHandle(state.instagram)}`, go: () => onNavigate('publishing'), connect: () => void connectInstagram() },
    { key: 'x', icon: <BrandMark platform="x" small/>, name: 'X posting', what: 'Lets the app post for one X account.', connected: state.x && `@${normalizeHandle(state.x)}`, go: () => onNavigate('publishing') },
    { key: 'sources', icon: <span className="connection-icon"><Clapperboard size={16}/></span>, name: 'Video makers', what: 'Kling or Grok keys used to make AI videos.', connected: state.videoSources ? `${state.videoSources} ready` : null, go: () => onNavigate('sources') },
  ];
  return <section className="connections" aria-label="Connections">
    <div className="sign-ins-head">
      <div><h2><Link2 size={16}/> Connections</h2><p>What the app is really signed in to. Anything not connected can't be used until you connect it.</p></div>
      <button type="button" className="outline-button small-button" disabled={loading} onClick={refresh}><RefreshCw size={14}/> Check again</button>
    </div>
    <div className="card connection-list">{rows.map((row) => <div className="connection-row" key={row.key}>
      {row.icon}
      <div><strong>{row.name}</strong><small>{row.what}</small></div>
      <span className={`pill ${row.connected ? 'active' : 'planned'}`}><span className="dot"/>{loading ? 'Checking…' : row.connected ? `Connected · ${row.connected}` : 'Not connected'}</span>
      <button type="button" className={row.connected ? 'ghost-button small-button' : 'primary-button small-button'} disabled={working} onClick={!row.connected && row.connect ? row.connect : row.go}>{row.connected ? 'Manage' : 'Connect'}</button>
    </div>)}</div>
    {instagramProfiles.length > 1 && !state.instagram && <label className="connection-pick">Instagram profile to connect <select value={igProfile || instagramProfiles[0].id} onChange={(event) => setIgProfile(event.target.value)}>{instagramProfiles.map((account) => <option key={account.id} value={account.id}>@{account.handle}</option>)}</select></label>}
    {setup && <form className="card backup-form" onSubmit={saveApp} aria-label="Set up Instagram once">
      <strong>One-time setup for Instagram</strong>
      <small>Instagram only lets apps connect through a Meta app. In developers.facebook.com, open your app, add Instagram → API setup with Instagram login, and copy the Instagram App ID and Instagram App Secret. Under Business login settings, add this redirect address: <code>{INSTAGRAM_REDIRECT_URI}</code>. After this, Connect is one click.</small>
      <div className="field-row"><div><label htmlFor="ig-app-id">Instagram App ID</label><input id="ig-app-id" inputMode="numeric" autoComplete="off" value={appId} onChange={(event) => setAppId(event.target.value)}/></div>
        <div><label htmlFor="ig-app-secret">Instagram App Secret</label><input id="ig-app-secret" type="password" autoComplete="off" value={appSecret} onChange={(event) => setAppSecret(event.target.value)}/></div></div>
      <div className="inline-add"><button className="primary-button small-button" disabled={working || !appId.trim() || !appSecret.trim()}>Save and connect</button><button type="button" className="ghost-button small-button" onClick={() => setSetup(false)}>Cancel</button></div>
    </form>}
    {note && <p className="success-message" role="status">{note}</p>}
  </section>;
}
