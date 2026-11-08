import InstagramPublisher from './InstagramPublisher';
import XPublisher from './XPublisher';
import ChannelManagement, { ChannelOverview } from './ChannelManagement';
import VideoQueue from './VideoQueue';
import KlingStudio from './KlingStudio';
import EmailSettings from './EmailSettings';
import AssistantPanel from './assistant/AssistantPanel';
import { chooseImageFile, loadImagePreview } from './profileService';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Bot, ImagePlus, CalendarClock, Check, ChevronRight, AppWindow, Globe2, LayoutGrid, Link2, Plus, Radio, Settings2, Sparkles, UsersRound, X as Close } from 'lucide-react';
import { accountCountLabel, BIO_LIMITS, createAccount, EMPTY_WORKSPACE, getPlatform, PLATFORMS, type Account, type Platform, type PlatformAction, type View, type Workspace } from './model';
import { loadWorkspace, openKling, openPlatformAction, saveWorkspace } from './service';

const NAV: { id: View; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid }, { id: 'accounts', label: 'Accounts', icon: UsersRound }, { id: 'channels', label: 'Channels', icon: Radio }, { id: 'queue', label: 'Video queue', icon: CalendarClock },
  { id: 'publishing', label: 'Publishing', icon: ArrowUpRight }, { id: 'creative', label: 'Creative tools', icon: Sparkles },
];
const TITLES: Record<View, string> = { overview: 'Overview', accounts: 'Accounts', channels: 'Channels', queue: 'Video queue', publishing: 'Publishing', creative: 'Creative tools', settings: 'Workspace settings' };

function BrandMark({ platform, small = false }: { platform: Platform; small?: boolean }) {
  const item = getPlatform(platform);
  return <span className={`platform-mark ${small ? 'small' : ''} ${platform}`} aria-label={item.name}>{item.mark}</span>;
}
function App() {
  const [view, setView] = useState<View>('overview');
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [showAccount, setShowAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => { loadWorkspace().then((data) => { setWorkspace(data); setBusinessName(data.businessName); setLoaded(true); }).catch(() => setMessage('Could not load your workspace. Restart the app and try again.')); }, []);
  async function persist(next: Workspace, success: string) {
    if (busy || !loaded) return;
    setBusy(true); setMessage('');
    try { const saved = await saveWorkspace(next); setWorkspace(saved); setBusinessName(saved.businessName); setMessage(success); return true; }
    catch { setMessage('Could not save your changes. Please try again.'); return false; }
    finally { setBusy(false); }
  }
  // The assistant saves directly so several tool calls in one reply build on each other.
  async function saveFromAssistant(next: Workspace) {
    if (!loaded) throw new Error('The workspace has not loaded yet.');
    const saved = await saveWorkspace(next);
    workspaceRef.current = saved;
    setWorkspace(saved); setBusinessName(saved.businessName);
    return saved;
  }
  async function launch(platform: Platform, action: PlatformAction) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await openPlatformAction(platform, action); }
    catch { setMessage('Could not open the platform page. Please try again.'); }
    finally { setBusy(false); }
  }
  async function launchKling() {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await openKling(); } catch { setMessage('Could not open Kling. Please try again.'); } finally { setBusy(false); }
  }
  async function saveAccount(account: Account) {
    const exists = workspace.accounts.some((item) => item.id === account.id);
    const accounts = exists ? workspace.accounts.map((item) => item.id === account.id ? account : item) : [...workspace.accounts, account];
    const channels = workspace.channels.map((channel) => channel.accountId === account.id && channel.platform !== account.platform ? { ...channel, accountId: null } : channel);
    if (await persist({ ...workspace, accounts, channels }, exists ? 'Account details saved.' : 'Account added to your workspace.')) { setShowAccount(false); setEditingAccount(null); }
  }
  async function removeAccount(account: Account) {
    if (!window.confirm(`Remove ${account.label} from this workspace? This will not delete the platform account.`)) return;
    if (await persist({ ...workspace, accounts: workspace.accounts.filter((item) => item.id !== account.id), channels: workspace.channels.map((channel) => channel.accountId === account.id ? { ...channel, accountId: null } : channel) }, 'Account removed from this workspace.')) { setShowAccount(false); setEditingAccount(null); }
  }
  const activePlatforms = new Set(workspace.accounts.filter((account) => account.status === 'active').map((account) => account.platform)).size;
  const addAccount = () => { setEditingAccount(null); setShowAccount(true); };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-symbol"><span></span><span></span><span></span><span></span></div><div><strong>Social<span>space</span></strong><small>YOUR SOCIAL WORKSPACE</small></div></div>
      <div className="workspace-label">Workspace</div>
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => setView(id)}><Icon size={19} strokeWidth={1.8}/><span>{label}</span>{view === id && <span className="nav-dot"/>}</button>)}</nav>
      <div className="sidebar-bottom"><button className={`nav-item ${view === 'settings' ? 'selected' : ''}`} onClick={() => setView('settings')}><Settings2 size={19}/><span>Settings</span></button><div className="sidebar-profile"><div className="profile-avatar">{workspace.businessName.trim().charAt(0).toUpperCase() || 'S'}</div><div><strong>{workspace.businessName || 'Your workspace'}</strong><small>Local workspace</small></div><ChevronRight size={16}/></div></div>
    </aside>
    <main className="main"><header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={14}/> <span>{TITLES[view]}</span></div><div className="topbar-right"><span className="local-badge"><span/> Local workspace</span><div className="top-avatar">{workspace.businessName.trim().charAt(0).toUpperCase() || 'S'}</div></div></header>
      <div className="page-content">
        {message && <div role="status" className="notice"><Check size={16}/>{message}<button onClick={() => setMessage('')} aria-label="Dismiss message"><Close size={16}/></button></div>}
        {view === 'overview' && <>
          <div className="heading-row"><div><p className="greeting">Your space to show up</p><h1>Everything social,<br/><span>all in one place.</span></h1><p className="heading-copy">A little more organized. A lot more you.</p></div><button className="primary-button" disabled={!loaded} onClick={addAccount}><Plus size={18}/> Add an account</button></div>
          <section className="welcome-panel"><div className="welcome-copy"><div className="pill"><span className="pulse-dot"/> YOUR WORKSPACE</div><h2>Make room for<br/>your next big idea<span>.</span></h2><p>Bring your accounts together and get to the right place to create, publish, and grow your presence.</p><button className="light-button" onClick={() => setView('accounts')}>Explore your accounts <ArrowUpRight size={16}/></button></div><div className="orbit-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><div className="brand-symbol large"><span/><span/><span/><span/></div></div><div className="orbit-icon ig">◎</div><div className="orbit-icon tt">♪</div><div className="orbit-icon yt">▶</div><div className="orbit-icon xx">𝕏</div><span className="star star-one">✳</span><span className="star star-two">✦</span></div></section>
          <div className="overview-grid"><section className="platform-section"><div className="section-heading"><div><h2>Your platforms</h2><p>All your corners of the internet.</p></div><button className="text-button" onClick={() => setView('accounts')}>View accounts <ChevronRight size={16}/></button></div><div className="platform-list">{PLATFORMS.map((platform) => { const count = workspace.accounts.filter((a) => a.platform === platform.id).length; return <button className="platform-row" key={platform.id} onClick={() => setView('accounts')}><BrandMark platform={platform.id}/><span className="platform-info"><strong>{platform.name}</strong><small>{platform.description}</small></span><span className="platform-state">{count ? accountCountLabel(count) : 'Not added'}</span><ChevronRight size={17}/></button>; })}</div></section>
          <div className="overview-side"><section className="snapshot"><div className="section-heading"><div><h2>At a glance</h2><p>Your workspace, right now.</p></div><span className="sparkle-icon">✳</span></div><div className="stat-row"><div><strong>{workspace.accounts.length.toString().padStart(2, '0')}</strong><span>Accounts added</span></div><div><strong>{activePlatforms.toString().padStart(2, '0')}</strong><span>Platforms in use</span></div></div><p className="stat-note">Based on the account details you save here.</p></section><section className="creative-teaser"><div className="teaser-icon"><Sparkles size={19}/></div><div><h3>Ideas in motion</h3><p>Meet your creative toolkit, starting with Kling AI.</p><button className="text-button purple" onClick={() => setView('creative')}>Explore tools <ArrowUpRight size={15}/></button></div></section></div></div>
          <ChannelOverview workspace={workspace} onView={() => setView('channels')}/>
        </>}
        {view === 'channels' && <ChannelManagement workspace={workspace} busy={busy} loaded={loaded} onSave={persist} onOpen={launch}/>}
        {view === 'queue' && <><div className="page-heading"><div><p className="greeting">Your content, lined up</p><h1>Video queue</h1><p>Plan videos for your channels in one place.</p></div></div><VideoQueue workspace={workspace}/></>}
        {view === 'accounts' && <><div className="page-heading"><div><p className="greeting">Your presence</p><h1>Accounts</h1><p>Keep track of the accounts that represent your business.</p></div><button className="primary-button" disabled={!loaded} onClick={addAccount}><Plus size={18}/> Add an account</button></div><div className="info-banner"><Link2 size={19}/><span>Accounts saved here are a local directory. Adding one does not sign in or connect it to an API.</span></div><div className="account-platforms">{PLATFORMS.map((platform) => { const accounts = workspace.accounts.filter((account) => account.platform === platform.id); return <section className="account-card" key={platform.id}><div className="card-head"><BrandMark platform={platform.id}/><div><h2>{platform.name}</h2><p>{platform.description}</p></div><span className="count-chip">{accountCountLabel(accounts.length)}</span></div>{accounts.length ? <div className="saved-accounts">{accounts.map((account) => <button key={account.id} className="saved-account" onClick={() => { setEditingAccount(account); setShowAccount(true); }}><div><strong>{account.label}</strong><small>{account.handle ? `@${account.handle}` : 'No handle added'} · {account.status === 'active' ? 'In use' : 'Planned'}</small></div><ChevronRight size={17}/></button>)}</div> : <p className="empty-account">No accounts added yet.</p>}<div className="card-actions"><button disabled={busy} onClick={() => launch(platform.id, 'create')}>{platform.id === 'youtube' ? 'Create channel' : 'Create account'} <AppWindow size={14}/></button><button disabled={busy} onClick={() => launch(platform.id, 'manage')}>Manage <AppWindow size={14}/></button></div></section>; })}</div></>}
        {view === 'publishing' && <><div className="page-heading"><div><p className="greeting">Ready when you are</p><h1>Publishing</h1><p>Choose a platform to create and publish in its own tools.</p></div></div><div className="info-banner"><ArrowDownLeft size={19}/><span>Publishing opens the platform in an app window. Sign in there to create or upload your content.</span></div><div className="publish-list">{PLATFORMS.map((platform) => <section className="publish-row" key={platform.id}><BrandMark platform={platform.id}/><div><h2>{platform.name}</h2><p>{platform.description}</p></div><button className="outline-button" disabled={busy} onClick={() => launch(platform.id, 'post')}>{platform.postLabel} <AppWindow size={15}/></button></section>)}</div><XPublisher/><InstagramPublisher/><div className="footnote">Scheduling and direct publishing to TikTok and YouTube are not connected yet. Platform availability and approvals vary.</div></>}
        {view === 'creative' && <><div className="page-heading"><div><p className="greeting">From idea to something real</p><h1>Creative tools</h1><p>A home for the tools that help bring your content to life.</p></div></div><KlingStudio openKling={launchKling} busy={busy}/></>}
        {view === 'settings' && <><div className="page-heading"><div><p className="greeting">Make it yours</p><h1>Workspace settings</h1><p>Set the business name you want to see in your workspace.</p></div></div><form className="settings-card" onSubmit={(event) => { event.preventDefault(); void persist({ ...workspace, businessName: businessName.trim() }, 'Workspace settings saved.'); }}><h2>Business details</h2><p>This is for your reference and does not register or update your LLC with a platform.</p><label htmlFor="business">Business or LLC name</label><input id="business" value={businessName} maxLength={120} onChange={(event) => setBusinessName(event.target.value)} placeholder="e.g. Your Business LLC"/><button className="primary-button" disabled={busy || !loaded}>Save changes</button></form><div className="privacy-note"><Globe2 size={18}/><span>Your workspace details are stored locally on this device. Platform accounts and passwords stay with their respective services.</span></div><EmailSettings/></>}
      </div>
    </main>
    {assistantOpen ? <AssistantPanel onClose={() => setAssistantOpen(false)} context={{ getWorkspace: () => workspaceRef.current, saveWorkspace: saveFromAssistant, navigate: setView }}/>
      : <button className="assistant-toggle" onClick={() => setAssistantOpen(true)}><Bot size={18}/> Assistant</button>}
    {showAccount && <AccountDialog account={editingAccount} busy={busy} onClose={() => { setShowAccount(false); setEditingAccount(null); }} onSave={saveAccount} onRemove={removeAccount}/>}
  </div>;
}
function AccountDialog({ account, busy, onClose, onSave, onRemove }: { account: Account | null; busy: boolean; onClose: () => void; onSave: (account: Account) => Promise<void>; onRemove: (account: Account) => Promise<void> }) {
  const [platform, setPlatform] = useState<Platform>(account?.platform ?? 'instagram');
  const [label, setLabel] = useState(account?.label ?? '');
  const [handle, setHandle] = useState(account?.handle ?? '');
  const [status, setStatus] = useState<Account['status']>(account?.status ?? 'planned');
  const [notes, setNotes] = useState(account?.notes ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [bio, setBio] = useState(account?.bio ?? '');
  const [website, setWebsite] = useState(account?.website ?? '');
  const [signupEmail, setSignupEmail] = useState(account?.signupEmail ?? '');
  const [imagePath, setImagePath] = useState(account?.imagePath ?? '');
  const [preview, setPreview] = useState('');
  const [imageError, setImageError] = useState('');
  useEffect(() => { setPreview(''); if (imagePath) loadImagePreview(imagePath).then(setPreview).catch(() => setPreview('')); }, [imagePath]);
  const bioLimit = BIO_LIMITS[platform];
  async function pickImage() { setImageError(''); try { const path = await chooseImageFile(); if (path) setImagePath(path); } catch (reason) { setImageError(reason instanceof Error ? reason.message : String(reason)); } }
  function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !label.trim() || bio.trim().length > bioLimit) return;
    const next = { ...account, ...createAccount(platform, label, handle, status, notes), displayName: displayName.trim(), bio: bio.trim(), website: website.trim(), signupEmail: signupEmail.trim(), imagePath };
    void onSave(account ? { ...next, id: account.id } : next);
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="dialog-header"><div><p className="greeting">Your account directory</p><h2 id="dialog-title">{account ? 'Edit account' : 'Add an account'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close" disabled={busy}><Close size={20}/></button></div><p className="dialog-copy">Save a reference to an account here. This won't sign you in or create an account.</p><form onSubmit={submit}><label htmlFor="platform">Platform</label><select id="platform" value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>{PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><label htmlFor="label">Account name</label><input id="label" autoFocus value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Your business" required/><label htmlFor="handle">Handle <span>optional</span></label><input id="handle" value={handle} maxLength={120} onChange={(event) => setHandle(event.target.value)} placeholder="@yourbusiness"/><label htmlFor="status">Status</label><select id="status" value={status} onChange={(event) => setStatus(event.target.value as Account['status'])}><option value="planned">Planned</option><option value="active">In use</option></select><label htmlFor="notes">Notes <span>optional</span></label><textarea id="notes" value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} placeholder="Notes (do not enter passwords or API keys)" rows={3}/><label htmlFor="display-name">Display name <span>optional</span></label><input id="display-name" value={displayName} maxLength={120} onChange={(event) => setDisplayName(event.target.value)}/><label htmlFor="bio">Profile description <span className={`bio-count ${bio.trim().length > bioLimit ? 'over' : ''}`}>{bio.trim().length}/{bioLimit}</span></label><textarea id="bio" value={bio} maxLength={1000} rows={3} onChange={(event) => setBio(event.target.value)}/><label htmlFor="website">Website <span>optional</span></label><input id="website" value={website} maxLength={300} onChange={(event) => setWebsite(event.target.value)}/><label htmlFor="signup-email">Sign-up email <span>optional</span></label><input id="signup-email" type="email" value={signupEmail} maxLength={320} onChange={(event) => setSignupEmail(event.target.value)}/><label>Profile image <span>optional</span></label><div className="profile-image">{preview && <img src={preview} alt="Profile preview"/>}<span>{imagePath ? imagePath.split(/[\\/]/).pop() : 'No image chosen'}</span><button type="button" className="outline-button" disabled={busy} onClick={() => void pickImage()}><ImagePlus size={15}/> Choose</button>{imagePath && <button type="button" className="remove-button" onClick={() => setImagePath('')}>Clear</button>}</div>{imageError && <div className="error-message" role="alert">{imageError}</div>}<div className="dialog-actions">{account && <button type="button" className="remove-button" disabled={busy} onClick={() => void onRemove(account)}>Remove</button>}<button type="button" className="outline-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !label.trim() || bio.trim().length > bioLimit}>{account ? 'Save changes' : 'Add account'}</button></div></form></section></div>;
}
export default App;






