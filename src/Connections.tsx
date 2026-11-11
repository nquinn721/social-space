import { useEffect, useState } from 'react';
import { Clapperboard, Link2, Mail, RefreshCw } from 'lucide-react';
import { connectGmailSession, emailConnection, openGmailSignIn } from './emailService';
import { saveInstagramApp } from './instagramService';
import InstagramAppSetup from './InstagramAppSetup';
import { listVideoSources } from './videoSourcesService';
import { listDeveloperApps, saveDeveloperApp } from './devAppsService';
import { canConnect, connectProfile, disconnectProfile, PROVIDER_OF, useProfileConnections } from './profileConnections';
import { TIKTOK_REDIRECT_URI, YOUTUBE_REDIRECT_URI } from './socialConnectService';
import { getPlatform, normalizeHandle, type Account, type Brand, type Platform, type View } from './model';
import { BrandMark, errorText } from './ui';
import SetupTracker from './SetupTracker';
import { useSetupStatus } from './setupService';

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
type Provider = 'meta' | 'x' | 'tiktok' | 'google';
type Setup = { provider: Provider; retry?: Account } | null;
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

/** Sets up a Google (YouTube) or TikTok developer app once: its client ID and secret. */
function KeyedAppSetup({ provider, working, onSave, onCancel }: { provider: 'google' | 'tiktok'; working: boolean; onSave: (id: string, secret: string) => Promise<void>; onCancel: () => void }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const google = provider === 'google';
  return <form className="card backup-form" aria-label={google ? 'Set up YouTube once' : 'Set up TikTok once'} onSubmit={(event) => { event.preventDefault(); if (id.trim() && secret.trim()) void onSave(id.trim(), secret.trim()); }}>
    <strong>One-time setup for {google ? 'YouTube' : 'TikTok'}</strong>
    {google
      ? <small>In console.cloud.google.com: create a project, enable <em>YouTube Data API v3</em>, set up the OAuth consent screen (add yourself as a test user), then <em>Credentials → Create OAuth client ID → Desktop app</em>. Copy its Client ID and Client secret here. The app signs in at <code>{YOUTUBE_REDIRECT_URI}</code>, which desktop clients allow without extra setup.</small>
      : <small>In developers.tiktok.com: create an app, add <em>Login Kit</em> and <em>Content Posting API</em>, choose the <em>Desktop</em> platform and add this redirect URI: <code>{TIKTOK_REDIRECT_URI}</code>. Copy the Client key and Client secret here. TikTok only allows public posting after it reviews the app.</small>}
    <div className="field-row"><div><label htmlFor={`${provider}-id`}>{google ? 'Client ID' : 'Client key'}</label><input id={`${provider}-id`} autoComplete="off" value={id} onChange={(event) => setId(event.target.value)}/></div>
      <div><label htmlFor={`${provider}-secret`}>Client secret</label><input id={`${provider}-secret`} type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)}/></div></div>
    <div className="inline-add"><button className="primary-button small-button" disabled={working || !id.trim() || !secret.trim()}>Save and connect</button><button type="button" className="ghost-button small-button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

/**
 * Connections in two layers: each social's developer app is set up once, then every live profile
 * connects on its own with one button, and posts through its own connection.
 */
/** profilesOnly: just the profiles' own connections, as on a brand's Accounts tab (one-time app setup still opens when needed). */
/**
 * marks/onMark: the setup checklist's hand-ticked steps, saved in the workspace.
 * onEditAccount: opens a profile to add its username and password.
 */
export default function Connections({ onNavigate, accounts = [], brands = [], profilesOnly = false, marks = {}, onMark, onEditAccount }: { onNavigate: (view: View, section?: string) => void; accounts?: Account[]; brands?: Brand[]; profilesOnly?: boolean; marks?: Record<string, number>; onMark?: (id: string, done: boolean) => void; onEditAccount?: (account: Account) => void }) {
  const { state, loading, refresh } = useConnectionState();
  const profiles = useProfileConnections(accounts);
  const [apps, setApps] = useState<Record<string, string | null>>({});
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState('');
  const [setup, setSetup] = useState<Setup>(null);
  const [checked, setChecked] = useState(0);
  const status = useSetupStatus(accounts, checked);
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
      setSetup(null); await profiles.refresh(); setChecked((value) => value + 1);
      setNote(`${getPlatform(account.platform).name} connected as @${normalizeHandle(username)} for ${brandName(account)}.`);
    } catch (reason) {
      const text = errorText(reason);
      if (text === 'SETUP_NEEDED') setSetup({ provider: PROVIDER_OF[account.platform], retry: account });
      else setNote(text);
    } finally { setWorking(false); }
  }
  async function disconnect(account: Account) {
    if (working || !window.confirm(`Disconnect ${getPlatform(account.platform).name} @${account.handle}? The app won't be able to post for it until you connect again.`)) return;
    setWorking(true); setNote('');
    try { await disconnectProfile(account); await profiles.refresh(); setChecked((value) => value + 1); }
    catch (reason) { setNote(errorText(reason)); } finally { setWorking(false); }
  }
  async function saveApp(provider: Provider, id: string, secret: string, configId?: string) {
    if (working) return;
    setWorking(true); setNote('');
    try {
      // The Meta app also needs its Unified login configuration, which only the Instagram command stores.
      await (provider === 'meta' ? saveInstagramApp(id, secret, configId) : saveDeveloperApp(provider, id, secret));
      await loadApps(); setChecked((value) => value + 1);
      const retry = setup?.retry;
      setSetup(null); setWorking(false);
      if (retry) await connect(retry);
    } catch (reason) { setNote(errorText(reason)); setWorking(false); }
  }

  const other: Row[] = [
    { key: 'inbox', icon: <span className="connection-icon"><Mail size={16}/></span>, name: 'Email inbox', what: 'Reads sign-up codes so they fill in by themselves.', connected: state.inbox, go: () => onNavigate('settings', 'email'), connect: () => void connectInbox() },
    { key: 'sources', icon: <span className="connection-icon"><Clapperboard size={16}/></span>, name: 'Video makers', what: 'Kling or Grok keys used to make AI videos.', connected: state.videoSources ? `${state.videoSources} ready` : null, go: () => onNavigate('settings', 'video-sources') },
  ];
  const appRows: { provider: Provider; name: string; what: string }[] = [
    { provider: 'meta', name: 'Meta app (Instagram)', what: 'Every Instagram profile connects through it.' },
    { provider: 'x', name: 'X app', what: 'Every X profile connects through it.' },
    { provider: 'google', name: 'Google app (YouTube)', what: 'Every YouTube channel connects through it.' },
    { provider: 'tiktok', name: 'TikTok app', what: 'Every TikTok profile connects through it.' },
  ];

  const byBrand = live.reduce<{ name: string; accounts: Account[] }[]>((groups, account) => {
    const name = brandName(account);
    const group = groups.find((item) => item.name === name);
    if (group) group.accounts.push(account); else groups.push({ name, accounts: [account] });
    return groups;
  }, []);
  const connectedCount = live.filter((account) => profiles.connected[account.id]).length;
  const SOCIAL_OF: Record<Provider, Platform> = { meta: 'instagram', x: 'x', google: 'youtube', tiktok: 'tiktok' };

  return <section className="connections" aria-label="Connections">
    <div className="sign-ins-head">
      <div><h2><Link2 size={16}/> Connections</h2><p>Connect each profile so the app can post as it.</p></div>
      <button type="button" className="ghost-button small-button" disabled={loading || profiles.loading} onClick={() => { refresh(); void profiles.refresh(); void loadApps(); setChecked((value) => value + 1); }}><RefreshCw size={14}/> Check again</button>
    </div>

    {note && <div className="notice conn-notice" role="status"><span>{note}</span><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNote('')}>×</button></div>}
    {setup?.provider === 'meta' && <InstagramAppSetup working={working} onSave={(id, secret, configId) => saveApp('meta', id, secret, configId)} onCancel={() => setSetup(null)}/>}
    {setup?.provider === 'x' && <XAppSetup working={working} onSave={(id) => saveApp('x', id, '')} onCancel={() => setSetup(null)}/>}
    {(setup?.provider === 'google' || setup?.provider === 'tiktok') && <KeyedAppSetup key={setup.provider} provider={setup.provider} working={working} onSave={(id, secret) => saveApp(setup.provider, id, secret)} onCancel={() => setSetup(null)}/>}

    <SetupTracker accounts={accounts} brands={brands} apps={status.apps} connections={status.connections} passwords={status.passwords} marks={marks}
      onMark={onMark} onConnect={(account) => void connect(account)} onSetupApp={(provider) => setSetup({ provider })} onEditAccount={onEditAccount} working={working}
      scope={profilesOnly && brands.length === 1 ? brands[0].name : undefined}/>

    <div className="card conn-card" aria-label="Profile connections">
      <div className="conn-card-head"><h3>Profiles</h3><small>{profiles.loading ? 'Checking…' : `${connectedCount} of ${live.length} connected`}</small></div>
      {live.length === 0 ? <p className="conn-empty">No live profiles yet. Once a profile exists on its social, connect it here.</p>
        : byBrand.map((group) => <div className="conn-group" key={group.name}>
          <div className="conn-brand">{group.name}</div>
          {group.accounts.map((account) => {
            const name = getPlatform(account.platform).name;
            const connectable = canConnect(account);
            const username = profiles.connected[account.id];
            const mismatch = username && account.handle && (account.platform === 'instagram' || account.platform === 'x') && normalizeHandle(username).toLowerCase() !== normalizeHandle(account.handle).toLowerCase();
            return <div className="conn-row" key={account.id} aria-label={`${name} @${account.handle}`}>
              <BrandMark platform={account.platform} small/>
              <div className="conn-text"><strong>{name}</strong><small>@{account.handle}{mismatch ? ` · connected as @${normalizeHandle(username)}` : ''}</small></div>
              {!connectable ? <span className="pill planned">Coming soon</span>
                : <span className={`pill ${username ? 'active' : 'planned'}`}><span className="dot"/>{profiles.loading ? 'Checking…' : username ? 'Connected' : 'Not connected'}</span>}
              <span className="conn-action">{connectable && (username
                ? <button type="button" className="ghost-button small-button" disabled={working} onClick={() => void disconnect(account)}>Disconnect</button>
                : <button type="button" className="primary-button small-button" disabled={working || profiles.loading} onClick={() => void connect(account)}>Connect</button>)}</span>
            </div>;
          })}
        </div>)}
    </div>

    {!profilesOnly && <div className="conn-columns">
      <div className="card conn-card" aria-label="Developer apps">
        <div className="conn-card-head"><h3>Set up once</h3><small>One developer app per social</small></div>
        {appRows.map((row) => <div className="conn-row" key={row.provider}>
          <BrandMark platform={SOCIAL_OF[row.provider]} small/>
          <div className="conn-text"><strong>{row.name}</strong></div>
          <span className={`pill ${apps[row.provider] ? 'active' : 'planned'}`}><span className="dot"/>{apps[row.provider] ? 'Set up' : 'Not set up'}</span>
          <span className="conn-action"><button type="button" className={apps[row.provider] ? 'ghost-button small-button' : 'outline-button small-button'} disabled={working} onClick={() => setSetup({ provider: row.provider })}>{apps[row.provider] ? 'Change' : 'Set up'}</button></span>
        </div>)}
      </div>
      <div className="card conn-card" aria-label="Other connections">
        <div className="conn-card-head"><h3>Other</h3><small>Used across all brands</small></div>
        {other.map((row) => <div className="conn-row" key={row.key}>
          {row.icon}
          <div className="conn-text"><strong>{row.name}</strong>{row.connected && <small>{row.connected}</small>}</div>
          <span className={`pill ${row.connected ? 'active' : 'planned'}`}><span className="dot"/>{loading ? 'Checking…' : row.connected ? 'Connected' : 'Not connected'}</span>
          <span className="conn-action"><button type="button" className={row.connected ? 'ghost-button small-button' : 'primary-button small-button'} disabled={working} onClick={!row.connected && row.connect ? row.connect : row.go}>{row.connected ? 'Manage' : 'Connect'}</button></span>
        </div>)}
      </div>
    </div>}
  </section>;
}
