import { useEffect, useState } from 'react';
import { Clapperboard, KeyRound, Link2, Mail, RefreshCw } from 'lucide-react';
import { connectGmailSession, emailConnection, openGmailSignIn } from './emailService';
import { disconnectInstagram, saveInstagramApp } from './instagramService';
import InstagramAppSetup from './InstagramAppSetup';
import { disconnectX } from './xService';
import { listVideoSources } from './videoSourcesService';
import { listDeveloperApps, saveDeveloperApp } from './devAppsService';
import { canConnect, connectProfile, useProfileConnections } from './profileConnections';
import { getPlatform, normalizeHandle, type Account, type Brand, type View } from './model';
import { BrandMark, errorText } from './ui';

/** What the app is really connected to. null means not connected (or it could not be checked). */
export type ConnectionState = {
  inbox: string | null;
  videoSources: number;
};
const EMPTY: ConnectionState = { inbox: null, videoSources: 0 };
const settle = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);

/** Checks every connection once when shown, and again on refresh. */
export function useConnectionState() {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([
      settle(emailConnection().then((value) => value?.username ?? null), null),
      settle(listVideoSources().then((value) => value.sources.filter((source) => source.status === 'verified').length), 0),
    ]).then(([inbox, videoSources]) => { if (live) setState({ inbox, videoSources }); });
    return () => { live = false; };
  }, [tick]);
  return { state: state ?? EMPTY, loading: state === null, refresh: () => setTick((value) => value + 1) };
}

type Row = { key: string; icon: React.ReactNode; name: string; what: string; connected: string | null; go: () => void; connect?: () => void };
type Setup = { provider: 'meta' | 'x'; retry?: Account } | null;
const X_CALLBACK = 'http://127.0.0.1:49173/callback';

/** Sets up the X developer app once: only its OAuth 2.0 Client ID is needed. */
function XAppSetup({ working, onSave, onCancel }: { working: boolean; onSave: (clientId: string) => Promise<void>; onCancel: () => void }) {
  const [clientId, setClientId] = useState('');
  return <form className="card backup-form" aria-label="Set up X once" onSubmit={(event) => { event.preventDefault(); if (clientId.trim()) void onSave(clientId.trim()); }}>
    <strong>One-time setup for X</strong>
    <small>In developer.x.com, open your app's <em>User authentication settings</em>: choose <em>Native App</em>, permissions <em>Read and write</em>, and add this callback address: <code>{X_CALLBACK}</code>. Then copy the <em>OAuth 2.0 Client ID</em> here. After this, Connect is one click for every X profile.</small>
    <label htmlFor="x-client-id">X Client ID</label><input id="x-client-id" autoComplete="off" value={clientId} onChange={(event) => setClientId(event.target.value)}/>
    <div className="inline-add"><button className="primary-button small-button" disabled={working || !clientId.trim()}>Save and connect</button><button type="button" className="ghost-button small-button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

/**
 * Connections in two layers: each social's developer app is set up once, then every live profile
 * connects on its own with one button, and posts through its own connection.
 */
export default function Connections({ onNavigate, accounts = [], brands = [] }: { onNavigate: (view: View, section?: string) => void; accounts?: Account[]; brands?: Brand[] }) {
  const { state, loading, refresh } = useConnectionState();
  const profiles = useProfileConnections(accounts);
  const [apps, setApps] = useState<Record<string, string | null>>({});
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState('');
  const [setup, setSetup] = useState<Setup>(null);
  const loadApps = () => listDeveloperApps().then((list) => setApps(Object.fromEntries(list.map((item) => [item.provider, item.id])))).catch(() => undefined);
  useEffect(() => { void loadApps(); }, []);
  const live = accounts.filter((account) => account.status === 'active').sort((a, b) => brandName(a).localeCompare(brandName(b)));
  function brandName(account: Account) { return brands.find((brand) => brand.id === account.brandId)?.name ?? account.label; }

  async function connectInbox() {
    if (working) return;
    setWorking(true); setNote('');
    try { await connectGmailSession(); refresh(); setNote('Inbox connected.'); }
    catch {
      try { await openGmailSignIn(); setNote('Sign in to Gmail in the window that opened, then press Connect again.'); }
      catch (reason) { setNote(errorText(reason)); }
    } finally { setWorking(false); }
  }
  async function connect(account: Account) {
    if (working) return;
    setWorking(true); setNote('');
    try {
      const username = await connectProfile(account);
      setSetup(null); await profiles.refresh();
      setNote(`${getPlatform(account.platform).name} connected as @${normalizeHandle(username)} for ${brandName(account)}.`);
    } catch (reason) {
      const text = errorText(reason);
      if (text === 'SETUP_NEEDED') setSetup({ provider: account.platform === 'instagram' ? 'meta' : 'x', retry: account });
      else setNote(text);
    } finally { setWorking(false); }
  }
  async function disconnect(account: Account) {
    if (working || !window.confirm(`Disconnect ${getPlatform(account.platform).name} @${account.handle}? The app won't be able to post for it until you connect again.`)) return;
    setWorking(true); setNote('');
    try { await (account.platform === 'instagram' ? disconnectInstagram(account.id) : disconnectX(account.id)); await profiles.refresh(); }
    catch (reason) { setNote(errorText(reason)); } finally { setWorking(false); }
  }
  async function saveApp(provider: 'meta' | 'x', id: string, secret: string, configId?: string) {
    if (working) return;
    setWorking(true); setNote('');
    try {
      // The Meta app also needs its Unified login configuration, which only the Instagram command stores.
      await (provider === 'meta' ? saveInstagramApp(id, secret, configId) : saveDeveloperApp(provider, id, secret));
      await loadApps();
      const retry = setup?.retry;
      setSetup(null); setWorking(false);
      if (retry) await connect(retry);
    } catch (reason) { setNote(errorText(reason)); setWorking(false); }
  }

  const other: Row[] = [
    { key: 'inbox', icon: <span className="connection-icon"><Mail size={16}/></span>, name: 'Email inbox', what: 'Reads sign-up codes so they fill in by themselves.', connected: state.inbox, go: () => onNavigate('settings', 'email'), connect: () => void connectInbox() },
    { key: 'sources', icon: <span className="connection-icon"><Clapperboard size={16}/></span>, name: 'Video makers', what: 'Kling or Grok keys used to make AI videos.', connected: state.videoSources ? `${state.videoSources} ready` : null, go: () => onNavigate('sources') },
  ];
  const appRows: { provider: 'meta' | 'x'; name: string; what: string }[] = [
    { provider: 'meta', name: 'Meta app (Instagram)', what: 'Every Instagram profile connects through it.' },
    { provider: 'x', name: 'X app', what: 'Every X profile connects through it.' },
  ];

  return <section className="connections" aria-label="Connections">
    <div className="sign-ins-head">
      <div><h2><Link2 size={16}/> Connections</h2><p>Each live profile connects on its own, so the app posts as that profile. Each social's developer app is set up once.</p></div>
      <button type="button" className="outline-button small-button" disabled={loading || profiles.loading} onClick={() => { refresh(); void profiles.refresh(); void loadApps(); }}><RefreshCw size={14}/> Check again</button>
    </div>

    <h3 className="connection-heading">Profiles</h3>
    {live.length === 0 ? <p className="footnote">No live profiles yet. Once a profile is created on its social, connect it here.</p>
      : <div className="card connection-list" aria-label="Profile connections">{live.map((account) => {
        const name = getPlatform(account.platform).name;
        const connectable = canConnect(account);
        const username = profiles.connected[account.id];
        const mismatch = username && account.handle && normalizeHandle(username).toLowerCase() !== normalizeHandle(account.handle).toLowerCase();
        return <div className="connection-row" key={account.id} aria-label={`${name} @${account.handle}`}>
          <BrandMark platform={account.platform} small/>
          <div><strong>{brandName(account)} · {name}</strong><small>@{account.handle}{mismatch ? ` · connected account is @${normalizeHandle(username)}` : ''}</small></div>
          {!connectable ? <span className="pill planned">Connect coming soon</span>
            : <span className={`pill ${username ? 'active' : 'planned'}`}><span className="dot"/>{profiles.loading ? 'Checking…' : username ? 'Connected' : 'Not connected'}</span>}
          {connectable && (username
            ? <button type="button" className="ghost-button small-button" disabled={working} onClick={() => void disconnect(account)}>Disconnect</button>
            : <button type="button" className="primary-button small-button" disabled={working || profiles.loading} onClick={() => void connect(account)}>Connect</button>)}
        </div>;
      })}</div>}

    {setup?.provider === 'meta' && <InstagramAppSetup working={working} onSave={(id, secret, configId) => saveApp('meta', id, secret, configId)} onCancel={() => setSetup(null)}/>}
    {setup?.provider === 'x' && <XAppSetup working={working} onSave={(id) => saveApp('x', id, '')} onCancel={() => setSetup(null)}/>}
    {note && <p className="success-message" role="status">{note}</p>}

    <h3 className="connection-heading">Set up once</h3>
    <div className="card connection-list" aria-label="Developer apps">{appRows.map((row) => <div className="connection-row" key={row.provider}>
      <span className="connection-icon"><KeyRound size={16}/></span>
      <div><strong>{row.name}</strong><small>{row.what}</small></div>
      <span className={`pill ${apps[row.provider] ? 'active' : 'planned'}`}><span className="dot"/>{apps[row.provider] ? 'Set up' : 'Not set up'}</span>
      <button type="button" className={apps[row.provider] ? 'ghost-button small-button' : 'outline-button small-button'} disabled={working} onClick={() => setSetup({ provider: row.provider })}>{apps[row.provider] ? 'Change' : 'Set up'}</button>
    </div>)}</div>
    <p className="footnote">TikTok and YouTube connections come next.</p>

    <h3 className="connection-heading">Other</h3>
    <div className="card connection-list">{other.map((row) => <div className="connection-row" key={row.key}>
      {row.icon}
      <div><strong>{row.name}</strong><small>{row.what}</small></div>
      <span className={`pill ${row.connected ? 'active' : 'planned'}`}><span className="dot"/>{loading ? 'Checking…' : row.connected ? `Connected · ${row.connected}` : 'Not connected'}</span>
      <button type="button" className={row.connected ? 'ghost-button small-button' : 'primary-button small-button'} disabled={working} onClick={!row.connected && row.connect ? row.connect : row.go}>{row.connected ? 'Manage' : 'Connect'}</button>
    </div>)}</div>
  </section>;
}
