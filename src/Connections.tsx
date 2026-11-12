import { useEffect, useState } from 'react';
import { Clapperboard, Link2, Mail, RefreshCw } from 'lucide-react';
import { connectGmailSession, emailConnection, openGmailSignIn } from './emailService';
import { saveInstagramApp } from './instagramService';
import DevAppSetupGuide from './DevAppSetupGuide';
import { listVideoSources } from './videoSourcesService';
import { saveDeveloperApp } from './devAppsService';
import { canConnect, connectProfile, disconnectProfile, PROVIDER_OF, useProfileConnections } from './profileConnections';
import InstagramIdPrompt from './InstagramIdPrompt';
import { INSTAGRAM_ID_NEEDED } from './instagramService';
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
/**
 * Connecting profiles, shared by the Setup tab and a brand's Accounts tab: one click connects a profile,
 * and opens the social's one-time app setup (then retries) when it is missing. `panels` holds the forms
 * and notices this needs; render it once above the profiles.
 */
export function useConnectFlow(accounts: Account[], brands: Brand[]) {
  const profiles = useProfileConnections(accounts);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState('');
  /** A profile Meta approved without naming its Instagram account; its ID finishes the connection. */
  const [needsId, setNeedsId] = useState<Account | null>(null);
  const [setup, setSetup] = useState<Setup>(null);
  const [checked, setChecked] = useState(0);
  const status = useSetupStatus(accounts, checked);
  const recheck = () => setChecked((value) => value + 1);
  function brandName(account: Account) { return brands.find((brand) => brand.id === account.brandId)?.name ?? account.label; }

  async function connect(account: Account) {
    if (working) return;
    setWorking(true); setNote('');
    try {
      const username = await connectProfile(account);
      setSetup(null); await profiles.refresh(); recheck();
      setNote(`${getPlatform(account.platform).name} connected as @${normalizeHandle(username)} for ${brandName(account)}.`);
    } catch (reason) {
      const text = errorText(reason);
      if (text === 'SETUP_NEEDED') setSetup({ provider: PROVIDER_OF[account.platform], retry: account });
      else if (text.startsWith(INSTAGRAM_ID_NEEDED)) setNeedsId(account);
      else setNote(text);
    } finally { setWorking(false); }
  }
  async function disconnect(account: Account) {
    if (working || !window.confirm(`Disconnect ${getPlatform(account.platform).name} @${account.handle}? The app won't be able to post for it until you connect again.`)) return;
    setWorking(true); setNote('');
    try { await disconnectProfile(account); await profiles.refresh(); recheck(); }
    catch (reason) { setNote(errorText(reason)); } finally { setWorking(false); }
  }
  async function saveApp(provider: Provider, id: string, secret: string, configId?: string) {
    if (working) return;
    setWorking(true); setNote('');
    try {
      // The Meta app also needs its Unified login configuration, which only the Instagram command stores.
      await (provider === 'meta' ? saveInstagramApp(id, secret, configId) : saveDeveloperApp(provider, id, secret));
      recheck();
      const retry = setup?.retry;
      setSetup(null); setWorking(false);
      if (retry) await connect(retry);
    } catch (reason) { setNote(errorText(reason)); setWorking(false); }
  }

  const panels = <>
    {note && <div className="notice conn-notice" role="status"><span>{note}</span><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNote('')}>×</button></div>}
    {needsId && <InstagramIdPrompt profile={needsId.id} handle={normalizeHandle(needsId.handle)} onCancel={() => setNeedsId(null)}
      onDone={(username) => { const account = needsId; setNeedsId(null); void profiles.refresh(); recheck(); setNote(`Instagram connected as @${normalizeHandle(username)} for ${brandName(account)}.`); }}/>}
    {setup && <DevAppSetupGuide key={setup.provider} provider={setup.provider} working={working} onSave={(id, secret, configId) => saveApp(setup.provider, id, secret, configId)} onCancel={() => setSetup(null)}/>}
  </>;
  return { profiles, status, working, setWorking, setNote, connect, disconnect, setupApp: (provider: Provider) => setSetup({ provider }), recheck, panels, brandName };
}

/**
 * Connections in two layers: each social's developer app is set up once, then every live profile
 * connects on its own with one button, and posts through its own connection.
 * marks/onMark: the setup checklist's hand-ticked steps, saved in the workspace.
 * onEditAccount: opens a profile to add its username and password.
 */
export default function Connections({ onNavigate, accounts = [], brands = [], marks = {}, onMark, onEditAccount }: { onNavigate: (view: View, section?: string) => void; accounts?: Account[]; brands?: Brand[]; marks?: Record<string, number>; onMark?: (id: string, done: boolean) => void; onEditAccount?: (account: Account) => void }) {
  const { state, loading, refresh } = useConnectionState();
  const flow = useConnectFlow(accounts, brands);
  const { profiles, status, working, setWorking, setNote, connect, disconnect, setupApp, recheck, brandName } = flow;
  const apps = status.apps ?? {};
  const live = accounts.filter((account) => account.status === 'active').sort((a, b) => brandName(a).localeCompare(brandName(b)));

  async function connectInbox() {
    if (working) return;
    setWorking(true); setNote('');
    try { await connectGmailSession(); refresh(); setNote('Inbox connected.'); }
    catch {
      try { await openGmailSignIn(); setNote('Sign in to Gmail in the window that opened, then press Connect again.'); }
      catch (reason) { setNote(errorText(reason)); }
    } finally { setWorking(false); }
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
      <button type="button" className="ghost-button small-button" disabled={loading || profiles.loading} onClick={() => { refresh(); void profiles.refresh(); recheck(); }}><RefreshCw size={14}/> Check again</button>
    </div>

    {flow.panels}

    <SetupTracker accounts={accounts} brands={brands} apps={status.apps} connections={status.connections} passwords={status.passwords} marks={marks}
      onMark={onMark} onConnect={(account) => void connect(account)} onSetupApp={setupApp} onEditAccount={onEditAccount} working={working}/>

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

    <div className="conn-columns">
      <div className="card conn-card" aria-label="Developer apps">
        <div className="conn-card-head"><h3>Set up once</h3><small>One developer app per social</small></div>
        {appRows.map((row) => <div className="conn-row" key={row.provider}>
          <BrandMark platform={SOCIAL_OF[row.provider]} small/>
          <div className="conn-text"><strong>{row.name}</strong></div>
          <span className={`pill ${apps[row.provider] ? 'active' : 'planned'}`}><span className="dot"/>{apps[row.provider] ? 'Set up' : 'Not set up'}</span>
          <span className="conn-action"><button type="button" className={apps[row.provider] ? 'ghost-button small-button' : 'outline-button small-button'} disabled={working} onClick={() => setupApp(row.provider)}>{apps[row.provider] ? 'Change' : 'Set up'}</button></span>
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
    </div>
  </section>;
}
