import { hasUpdate, HeaderUpdateButton, UpdateBanner, updateNavLabel, UpdatesPage, useAppUpdates } from './AppUpdates';
import InboxList from './InboxList';
import CreateAccountWizard, { type WizardPrefill } from './CreateAccountWizard';
import AccountDrawer from './AccountDrawer';
import AssistantPanel from './assistant/AssistantPanel';
import OverviewPage from './pages/OverviewPage';
import AccountsPage from './pages/AccountsPage';
import SettingsPage from './pages/SettingsPage';
import { deleteAccountPassword } from './profileService';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, ChevronRight, Home, Mail, RotateCw, Settings2, UsersRound, X as Close } from 'lucide-react';
import { EMPTY_WORKSPACE, getPlatform, PLATFORMS, type Account, type Brand, type Platform, type PlatformAction, type View, type Workspace } from './model';
import { loginText, renamedProfile } from './brands';
import appIcon from './assets/app-icon.png';
import { loadWorkspace, openPlatformAction, saveWorkspace } from './service';
import { initialOf, PageHeader } from './ui';
import { PartnerReviewProvider, usePartnerReview } from './usePartnerReview';
import { useTeamSync } from './useTeamSync';
import { mergeWorkspaces } from './workspaceSync';
import ReviewNotice from './ReviewNotice';
import { useReviewWatch } from './useReviewWatch';
import { moveTestVideos, seenKey, stateLabel, reviewOf, testVideos, withReviewState, type AppReview, type ReviewState } from './appReviews';
import { listDeveloperApps, switchToProductionApp } from './devAppsService';
import type { DevProvider } from './devAppsService';

type NavItem = { id: View; label: string; icon: typeof Home };
/** Brands hold everything else: each brand's posts (by category) and, tucked away, its accounts. */
const NAV_ITEMS: NavItem[] = [{ id: 'overview', label: 'Overview', icon: Home }, { id: 'accounts', label: 'Brands', icon: UsersRound }, { id: 'inbox', label: 'Inbox', icon: Mail }];
const TITLES: Record<View, string> = { overview: 'Overview', accounts: 'Brands', inbox: 'Inbox', updates: 'Updates', settings: 'Settings' };
/** Which brand page is open, and on which tab. */
export type OpenBrand = { id: string; tab: 'content' | 'accounts' } | null;
type Wizard = { platforms: Platform[]; prefill?: WizardPrefill; resume?: Account[] };

function App() {
  const [view, setView] = useState<View>('overview');
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const showMessage = (text: string) => { setMessageIsError(false); setMessage(text); };
  const showError = (text: string) => { setMessageIsError(true); setMessage(text); };
  const [showAccount, setShowAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const [openBrand, setOpenBrand] = useState<OpenBrand>(null);
  // Brands opens on its Setup tab when another page sends you there; the count remounts it.
  const [brandsStart, setBrandsStart] = useState<{ tab: 'brands' | 'connections'; count: number }>({ tab: 'brands', count: 0 });
  const updates = useAppUpdates();
  const updatesManaged = Boolean(updates.managedBy);
  const updateWaiting = !updatesManaged && (hasUpdate(updates.status) || updates.progress?.state === 'running');
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => { loadWorkspace().then((data) => { setWorkspace(data); setBusinessName(data.businessName); setLoaded(true); }).catch(() => showError('Could not load your workspace. Restart the app and try again.')); }, []);
  // Saves and team syncs run one at a time. A save prepared before a sync brought in the other PC's
  // changes is replayed on top of them, so neither side's edits are lost.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.current.then(work, work);
    queue.current = run.catch(() => undefined);
    return run;
  }
  async function store(next: Workspace) {
    const saved = await saveWorkspace(next);
    workspaceRef.current = saved;
    setWorkspace(saved); setBusinessName(saved.businessName);
    return saved;
  }
  function commit(next: Workspace) {
    const origin = workspaceRef.current;
    return exclusive(async () => {
      const saved = await store(workspaceRef.current === origin ? next : mergeWorkspaces(origin, next, workspaceRef.current));
      teamSync.saved();
      return saved;
    });
  }
  const teamSync = useTeamSync({ loaded, workspaceRef, exclusive, apply: store });
  // Watches the inbox for the socials' developer-app review results.
  const reviewWatch = useReviewWatch({ loaded, workspaceRef, save: commit, notify: showMessage });
  function setReview(provider: DevProvider, state: ReviewState) {
    const at = Date.now();
    // Set by hand: the user already knows, so no "review finished" notice for it.
    void persist({ ...workspace, setup: { ...withReviewState(workspace.setup, provider, state, at), [seenKey(provider)]: at } }, `${reviewOf(provider)?.name ?? 'Review'}: ${stateLabel(state)}.`);
  }
  function dismissReviews(providers: string[]) {
    const at = Date.now();
    void commit({ ...workspaceRef.current, setup: { ...(workspaceRef.current.setup ?? {}), ...Object.fromEntries(providers.map((provider) => [seenKey(provider as DevProvider), at])) } }).catch(() => showError('Could not save your changes. Please try again.'));
  }
  /** One click after approval: production keys replace the test keys, and test posts go back to waiting. */
  async function leaveTestMode(review: AppReview) {
    if (busy || !loaded || !review.test) return;
    const platform = review.test.platform;
    const name = getPlatform(platform).name;
    setBusy(true); setMessage('');
    try {
      let switched = false;
      if (review.productionKeys) {
        const app = (await listDeveloperApps()).find((item) => item.provider === review.provider);
        if (!app?.productionId) { showError(`Add ${name}'s production keys under Developer accounts first, then press Switch again.`); navigate('settings', 'developer-accounts'); return; }
        await switchToProductionApp(review.provider);
        switched = true;
      }
      const current = workspaceRef.current;
      const count = testVideos(current.videos, platform).length;
      await commit({ ...current, videos: moveTestVideos(current.videos, platform), setup: { ...(current.setup ?? {}), [seenKey(review.provider)]: Date.now() } });
      const moved = count ? ` ${count} test ${count === 1 ? 'video is' : 'videos are'} back in Waiting to post on ${name}${platform === 'youtube' ? '. Uploads from Testing stay Private on YouTube, so post them again or set them Public in YouTube Studio' : ', ready to post for real'}.` : '';
      showMessage(`${switched ? `${name} now uses its production keys. Press Reconnect on each ${name} profile, since its connection was made with the Sandbox app.` : `${name} is out of test mode.`}${moved}`);
    } catch (reason) { showError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function persist(next: Workspace, success: string) {
    if (busy || !loaded) return;
    setBusy(true); setMessage('');
    try { await commit(next); showMessage(success); return true; }
    catch { showError('Could not save your changes. Please try again.'); return false; }
    finally { setBusy(false); }
  }
  // The assistant saves directly so several tool calls in one reply build on each other.
  async function saveFromAssistant(next: Workspace) {
    if (!loaded) throw new Error('The workspace has not loaded yet.');
    return commit(next);
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
    catch { showError('Could not open the platform page. Please try again.'); }
    finally { setBusy(false); }
  }
  async function saveAccount(account: Account) {
    const exists = workspace.accounts.some((item) => item.id === account.id);
    const accounts = exists ? workspace.accounts.map((item) => item.id === account.id ? account : item) : [...workspace.accounts, account];
    const channels = workspace.channels.map((channel) => channel.accountId === account.id && channel.platform !== account.platform ? { ...channel, accountId: null } : channel);
    if (await persist({ ...workspace, accounts, channels }, exists ? 'Account details saved.' : 'Account added to your workspace.')) { setShowAccount(false); setEditingAccount(null); }
  }
  async function renameBrand(brand: Brand, name: string) {
    const old = brand.name;
    const accounts = workspace.accounts.map((account) => account.brandId === brand.id
      ? renamedProfile(account, old, name) : account);
    return persist({ ...workspace, brands: workspace.brands.map((item) => item.id === brand.id ? { ...item, name } : item), accounts }, `Renamed ${old} to ${name}. To change a username on a social, open that profile and use Fill profile.`);
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
  // Approved posts are saved straight away, even while another save is running.
  const review = usePartnerReview(workspace, loaded, async (next, success) => { await saveFromAssistant(next); showMessage(success); return true; });
  const signUp = (accounts: Account[]) => { setShowAccount(false); setEditingAccount(null); setWizard({ platforms: accounts.map((item) => item.platform), resume: accounts }); };
  function navigate(next: View, section?: string) {
    setView(next);
    if (next !== 'accounts') setOpenBrand(null);
    if (next === 'accounts' && section === 'setup') { setOpenBrand(null); setBrandsStart((current) => ({ tab: 'connections', count: current.count + 1 })); return; }
    if (next !== 'accounts') setBrandsStart((current) => current.tab === 'brands' ? current : { ...current, tab: 'brands' });
    if (section) window.setTimeout(() => document.getElementById(section)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 50);
    else document.documentElement.scrollTop = 0;
  }
  const navButton = ({ id, label, icon: Icon }: NavItem) => <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} aria-current={view === id ? "page" : undefined} aria-label={label} title={label} onClick={() => { navigate(id); if (id === 'accounts') setOpenBrand(null); }}>
    <Icon size={17} strokeWidth={1.9}/><span>{label}</span>{id === 'accounts' && workspace.brands.length > 0 && <span className="nav-badge">{workspace.brands.length}</span>}{id === 'updates' && updateWaiting && <span className="update-dot" aria-hidden="true"/>}
  </button>;

  return <PartnerReviewProvider value={review}><div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-symbol" src={appIcon} alt=""/><div><strong>Social <span>Space</span></strong><small>Your social workspace</small></div></div>
      <nav aria-label="Main navigation"><div className="nav-group">{NAV_ITEMS.map(navButton)}</div></nav>
      <div className="sidebar-bottom">
        {!updatesManaged && navButton({ id: 'updates', label: updateNavLabel(updates), icon: RotateCw })}
        {navButton({ id: 'settings', label: 'Settings', icon: Settings2 })}
        <div className="sidebar-profile"><div className="avatar">{initialOf(workspace.businessName)}</div><div><strong>{workspace.businessName || 'Your workspace'}</strong><small>{teamSync.status?.enabled ? 'Shared with your partner' : 'Stored on this PC'}</small></div></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="breadcrumb">Social Space <ChevronRight size={13}/> <span>{TITLES[view]}</span></div>
        <div className="topbar-right">
          <HeaderUpdateButton updates={updates} onOpen={() => navigate('updates')}/>
          <span className="local-badge"><span className="dot"/> Local workspace</span>
          <button className={`outline-button small-button assistant-button ${assistantOpen ? 'open' : ''}`} aria-pressed={assistantOpen} onClick={() => setAssistantOpen((value) => !value)}><Bot size={15}/> Assistant</button>
        </div>
      </header>
      <div className="page-content">
        {view !== 'updates' && <UpdateBanner updates={updates} onOpen={() => navigate('updates')}/>}
        <ReviewNotice marks={workspace.setup} videos={workspace.videos} busy={busy} onMove={(review) => void leaveTestMode(review)} onOpen={() => navigate('settings', 'developer-accounts')} onDismiss={dismissReviews}/>
        {message && <div role={messageIsError ? 'alert' : 'status'} className={messageIsError ? 'notice notice-error' : 'notice'}>{messageIsError ? <AlertTriangle size={16}/> : <Check size={16}/>}{message}<button onClick={() => setMessage('')} aria-label="Dismiss message"><Close size={16}/></button></div>}
        {view === 'overview' && <OverviewPage workspace={workspace} loaded={loaded} onNavigate={navigate} onOpenBrand={(id) => { setOpenBrand({ id, tab: 'content' }); setView('accounts'); }} onCreateAccounts={createAccounts} onAddAccount={addAccount} onOpenAssistant={() => setAssistantOpen(true)}/>}
        {view === 'accounts' && <AccountsPage key={brandsStart.count} startTab={brandsStart.tab} workspace={workspace} loaded={loaded} busy={busy} openBrand={openBrand} onOpenBrand={setOpenBrand} onSave={persist} onAddAccount={addAccount} onEditAccount={editAccount} onCreateAccounts={createAccounts} onSignUp={signUp} onAlreadyCreated={(account) => void alreadyCreated(account)} onOpen={launch} onRestore={persist} onRemoveAccount={(account) => void removeAccount(account)} onRemoveBrand={(brand) => void removeBrand(brand)} onRenameBrand={renameBrand} onNavigate={navigate}/>}
        {view === 'inbox' && <><PageHeader eyebrow="Verification codes and sign-up mail" title="Inbox" description="Newest mail from your connected inbox. Codes are pulled out so you can copy them in one click. Reading here doesn't mark anything as read."/><InboxList limit={40} autoRefresh/></>}
        {view === 'updates' && !updatesManaged && <UpdatesPage updates={updates}/>}
        {view === 'settings' && <SettingsPage businessName={businessName} onBusinessNameChange={setBusinessName} onSaveBusinessName={() => void persist({ ...workspace, businessName: businessName.trim() }, 'Workspace settings saved.')} busy={busy} loaded={loaded} updatesManagedBy={updates.managedBy} teamSync={teamSync} reviews={{ marks: workspace.setup, onSet: setReview, watch: reviewWatch, busy: busy || !loaded }}/>}
      </div>
    </main>
    {assistantOpen ? <AssistantPanel onClose={() => setAssistantOpen(false)} context={{ getWorkspace: () => workspaceRef.current, saveWorkspace: saveFromAssistant, navigate: setView }}/>
      : <button className="assistant-toggle" onClick={() => setAssistantOpen(true)}><Bot size={17}/> Ask assistant</button>}
    {wizard && <CreateAccountWizard initialPlatforms={wizard.platforms} prefill={wizard.prefill} resume={wizard.resume} existing={workspace.accounts} onSave={saveWizardAccount} onClose={() => setWizard(null)}/>}
    {showAccount && <AccountDrawer account={editingAccount} busy={busy} onClose={() => { setShowAccount(false); setEditingAccount(null); }} onSave={saveAccount} onRemove={removeAccount} onSignUp={(account) => signUp([account])} loginNote={editingAccount ? loginText(editingAccount, workspace) : undefined}/>}
  </div></PartnerReviewProvider>;
}
export default App;
