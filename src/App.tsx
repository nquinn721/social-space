import InstagramPublisher from './InstagramPublisher';
import XPublisher from './XPublisher';
import ChannelManagement from './ChannelManagement';
import VideoQueue from './VideoQueue';
import VideoLibrary from './VideoLibrary';
import VideoStudio from './VideoStudio';
import VideoSources from './VideoSources';
import { hasUpdate, UpdateBanner, updateNavLabel, UpdatesPage, useAppUpdates } from './AppUpdates';
import InboxList from './InboxList';
import CreateAccountWizard, { type WizardPrefill } from './CreateAccountWizard';
import AccountDrawer from './AccountDrawer';
import AssistantPanel from './assistant/AssistantPanel';
import OverviewPage from './pages/OverviewPage';
import AccountsPage from './pages/AccountsPage';
import SettingsPage from './pages/SettingsPage';
import { deleteAccountPassword } from './profileService';
import { useEffect, useRef, useState } from 'react';
import { Film, AppWindow, ArrowDownLeft, ArrowUpRight, Bot, CalendarClock, Check, ChevronRight, Clapperboard, Home, Mail, Radio, RotateCw, Settings2, Sparkles, UsersRound, X as Close } from 'lucide-react';
import { EMPTY_WORKSPACE, getPlatform, PLATFORMS, type Account, type Brand, type Platform, type PlatformAction, type View, type Workspace } from './model';
import { loginText } from './brands';
import { loadWorkspace, openPlatformAction, saveWorkspace } from './service';
import { BrandMark, initialOf, PageHeader } from './ui';

type NavItem = { id: View; label: string; icon: typeof Home };
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Workspace', items: [{ id: 'overview', label: 'Overview', icon: Home }, { id: 'accounts', label: 'Brands', icon: UsersRound }, { id: 'inbox', label: 'Inbox', icon: Mail }] },
  { label: 'Content', items: [{ id: 'library', label: 'Video library', icon: Film }, { id: 'channels', label: 'Channels', icon: Radio }, { id: 'queue', label: 'Video queue', icon: CalendarClock }, { id: 'publishing', label: 'Publishing', icon: ArrowUpRight }, { id: 'creative', label: 'Creative tools', icon: Sparkles }, { id: 'sources', label: 'Video sources', icon: Clapperboard }] },
];
const TITLES: Record<View, string> = { overview: 'Overview', accounts: 'Brands', inbox: 'Inbox', library: 'Video library', channels: 'Channels', queue: 'Video queue', publishing: 'Publishing', creative: 'Creative tools', sources: 'Video sources', updates: 'Updates', settings: 'Settings' };
type Wizard = { platforms: Platform[]; prefill?: WizardPrefill; resume?: Account[] };

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
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const updates = useAppUpdates();
  const updateWaiting = hasUpdate(updates.status) || updates.progress?.state === 'running';
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
  async function saveWizardAccount(account: Account) {
    const current = workspaceRef.current;
    const exists = current.accounts.some((item) => item.id === account.id);
    await saveFromAssistant({ ...current, accounts: exists ? current.accounts.map((item) => item.id === account.id ? account : item) : [...current.accounts, account] });
  }
  async function launch(platform: Platform, action: PlatformAction) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await openPlatformAction(platform, action); }
    catch { setMessage('Could not open the platform page. Please try again.'); }
    finally { setBusy(false); }
  }
  async function saveAccount(account: Account) {
    const exists = workspace.accounts.some((item) => item.id === account.id);
    const accounts = exists ? workspace.accounts.map((item) => item.id === account.id ? account : item) : [...workspace.accounts, account];
    const channels = workspace.channels.map((channel) => channel.accountId === account.id && channel.platform !== account.platform ? { ...channel, accountId: null } : channel);
    if (await persist({ ...workspace, accounts, channels }, exists ? 'Account details saved.' : 'Account added to your workspace.')) { setShowAccount(false); setEditingAccount(null); }
  }
  async function removeBrand(brand: Brand) {
    const profiles = workspace.accounts.filter((account) => account.brandId === brand.id);
    const live = profiles.filter((account) => account.status === 'active');
    const warning = live.length ? ` Its ${live.length} live ${live.length === 1 ? 'profile stays' : 'profiles stay'} on the socials, but the saved username and password here are deleted too.` : '';
    if (!window.confirm(`Delete ${brand.name} and its ${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'} from the app?${warning}`)) return;
    const ids = new Set(profiles.map((account) => account.id));
    if (await persist({ ...workspace, brands: workspace.brands.filter((item) => item.id !== brand.id), accounts: workspace.accounts.filter((account) => !ids.has(account.id)), categories: (workspace.categories ?? []).filter((category) => category.brandId !== brand.id), videos: (workspace.videos ?? []).filter((video) => video.brandId !== brand.id), channels: workspace.channels.map((channel) => channel.accountId && ids.has(channel.accountId) ? { ...channel, accountId: null } : channel) }, `Deleted ${brand.name}.`)) {
      for (const id of ids) void deleteAccountPassword(id).catch(() => undefined);
    }
  }
  async function removeAccount(account: Account) {
    if (!window.confirm(`Delete the ${getPlatform(account.platform).name} profile of ${account.label} from the app? ${account.status === 'active' ? 'The account stays on the social, but its saved password here is deleted.' : 'Nothing exists on the social yet, so nothing is lost there.'}`)) return;
    if (await persist({ ...workspace, accounts: workspace.accounts.filter((item) => item.id !== account.id), channels: workspace.channels.map((channel) => channel.accountId === account.id ? { ...channel, accountId: null } : channel) }, `Deleted the ${getPlatform(account.platform).name} profile of ${account.label}.`)) { setShowAccount(false); setEditingAccount(null); void deleteAccountPassword(account.id).catch(() => undefined); }
  }
  const addAccount = () => { setEditingAccount(null); setShowAccount(true); };
  const editAccount = (account: Account) => { setEditingAccount(account); setShowAccount(true); };
  const createAccounts = (platforms?: Platform[], prefill?: WizardPrefill) => setWizard({ platforms: platforms ?? PLATFORMS.map((item) => item.id), prefill });
  /** Goes straight to the sign-up pages of accounts that are saved but not created yet. */
  async function alreadyCreated(account: Account) {
    const live = { ...account, status: 'active' as const };
    if (await persist({ ...workspace, accounts: workspace.accounts.map((item) => item.id === account.id ? live : item) }, `Marked ${account.label} on ${getPlatform(account.platform).name} as live. Check the username and add its password.`)) editAccount(live);
  }
  const signUp = (accounts: Account[]) => { setShowAccount(false); setEditingAccount(null); setWizard({ platforms: accounts.map((item) => item.platform), resume: accounts }); };
  function navigate(next: View, section?: string) {
    setView(next);
    if (section) window.setTimeout(() => document.getElementById(section)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 50);
    else document.documentElement.scrollTop = 0;
  }
  const navButton = ({ id, label, icon: Icon }: NavItem) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} aria-current={view === id ? "page" : undefined} aria-label={label} title={label} onClick={() => navigate(id)}>
    <Icon size={17} strokeWidth={1.9}/><span>{label}</span>{id === 'accounts' && workspace.brands.length > 0 && <span className="nav-badge">{workspace.brands.length}</span>}{id === 'updates' && updateWaiting && <span className="update-dot" aria-hidden="true"/>}
  </button>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-symbol"><span></span><span></span><span></span><span></span></div><div><strong>Social<span>space</span></strong><small>Your social workspace</small></div></div>
      <nav aria-label="Main navigation">{NAV_GROUPS.map((group) => <div className="nav-group" key={group.label}><div className="nav-label">{group.label}</div>{group.items.map(navButton)}</div>)}</nav>
      <div className="sidebar-bottom">
        {navButton({ id: 'updates', label: updateNavLabel(updates), icon: RotateCw })}
        {navButton({ id: 'settings', label: 'Settings', icon: Settings2 })}
        <div className="sidebar-profile"><div className="avatar">{initialOf(workspace.businessName)}</div><div><strong>{workspace.businessName || 'Your workspace'}</strong><small>Stored on this PC</small></div></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="breadcrumb">Socialspace <ChevronRight size={13}/> <span>{TITLES[view]}</span></div>
        <div className="topbar-right">
          <span className="local-badge"><span className="dot"/> Local workspace</span>
          <button className={`outline-button small-button assistant-button ${assistantOpen ? 'open' : ''}`} aria-pressed={assistantOpen} onClick={() => setAssistantOpen((value) => !value)}><Bot size={15}/> Assistant</button>
        </div>
      </header>
      <div className="page-content">
        {view !== 'updates' && <UpdateBanner updates={updates} onOpen={() => navigate('updates')}/>}
        {message && <div role="status" className="notice"><Check size={16}/>{message}<button onClick={() => setMessage('')} aria-label="Dismiss message"><Close size={16}/></button></div>}
        {view === 'overview' && <OverviewPage workspace={workspace} loaded={loaded} onNavigate={navigate} onCreateAccounts={createAccounts} onAddAccount={addAccount} onOpenAssistant={() => setAssistantOpen(true)}/>}
        {view === 'accounts' && <AccountsPage workspace={workspace} loaded={loaded} busy={busy} onAddAccount={addAccount} onEditAccount={editAccount} onCreateAccounts={createAccounts} onSignUp={signUp} onAlreadyCreated={(account) => void alreadyCreated(account)} onOpen={launch} onRestore={persist} onOpenLibrary={() => navigate('library')} onRemoveAccount={(account) => void removeAccount(account)} onRemoveBrand={(brand) => void removeBrand(brand)}/>}
        {view === 'inbox' && <><PageHeader eyebrow="Verification codes and sign-up mail" title="Inbox" description="Newest mail from your connected inbox. Codes are pulled out so you can copy them in one click. Reading here doesn't mark anything as read."/><InboxList limit={40} autoRefresh/></>}
        {view === 'library' && <VideoLibrary workspace={workspace} loaded={loaded} busy={busy} onSave={persist} onOpen={launch} onManageSources={() => navigate('sources')}/>}
        {view === 'channels' && <ChannelManagement workspace={workspace} busy={busy} loaded={loaded} onSave={persist} onOpen={launch}/>}
        {view === 'queue' && <><PageHeader eyebrow="Your content, lined up" title="Video queue" description="Plan videos for your channels in one place."/><VideoQueue workspace={workspace}/></>}
        {view === 'publishing' && <><PageHeader eyebrow="Ready when you are" title="Publishing" description="Create and publish in each platform's own tools, or post to X and Instagram from here."/><div className="info-banner"><ArrowDownLeft size={18}/><span>Publishing opens the platform in an app window. Sign in there to create or upload your content.</span></div><div className="publish-list">{PLATFORMS.map((platform) => <section className="publish-row" key={platform.id}><BrandMark platform={platform.id}/><div><h2>{platform.name}</h2><p>{platform.description}</p></div><button className="outline-button" disabled={busy} onClick={() => launch(platform.id, 'post')}>{platform.postLabel} <AppWindow size={15}/></button></section>)}</div><XPublisher/><InstagramPublisher/><div className="footnote">Scheduling and direct publishing to TikTok and YouTube are not connected yet. Platform availability and approvals vary.</div></>}
        {view === 'creative' && <><PageHeader eyebrow="From idea to something real" title="Creative tools" description="A home for the tools that help bring your content to life."/><VideoStudio onManageSources={() => navigate('sources')}/></>}
        {view === 'sources' && <><PageHeader eyebrow="Where your videos come from" title="Video sources" description="Connect AI video providers with your own API keys. Each key is verified with the provider and kept in Windows Credential Manager."/><VideoSources/></>}
        {view === 'updates' && <UpdatesPage updates={updates}/>}
        {view === 'settings' && <SettingsPage businessName={businessName} onBusinessNameChange={setBusinessName} onSaveBusinessName={() => void persist({ ...workspace, businessName: businessName.trim() }, 'Workspace settings saved.')} busy={busy} loaded={loaded}/>}
      </div>
    </main>
    {assistantOpen ? <AssistantPanel onClose={() => setAssistantOpen(false)} context={{ getWorkspace: () => workspaceRef.current, saveWorkspace: saveFromAssistant, navigate: setView }}/>
      : <button className="assistant-toggle" onClick={() => setAssistantOpen(true)}><Bot size={17}/> Ask assistant</button>}
    {wizard && <CreateAccountWizard initialPlatforms={wizard.platforms} prefill={wizard.prefill} resume={wizard.resume} existing={workspace.accounts} onSave={saveWizardAccount} onClose={() => setWizard(null)}/>}
    {showAccount && <AccountDrawer account={editingAccount} busy={busy} onClose={() => { setShowAccount(false); setEditingAccount(null); }} onSave={saveAccount} onRemove={removeAccount} onSignUp={(account) => signUp([account])} loginNote={editingAccount ? loginText(editingAccount, workspace) : undefined}/>}
  </div>;
}
export default App;
