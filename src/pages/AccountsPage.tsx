import { useMemo, useState } from 'react';
import { AppWindow, ArrowLeft, ChevronRight, Pencil, Plus, Search, Trash2, TriangleAlert, UserPlus, UsersRound } from 'lucide-react';
import VideoLibrary from '../VideoLibrary';
import type { OpenBrand } from '../App';
import { getPlatform, PLATFORMS, type Account, type Brand, type Platform, type PlatformAction, type View, type Workspace } from '../model';
import { migrateWorkspace, planPresence, presenceIssues } from '../brands';
import { AccountAvatar, BrandMark, PageHeader } from '../ui';
import '../brands.css';
import SignIns from '../SignIns';
import Connections from '../Connections';
import { DEFAULT_SIGNUP_EMAIL, type WizardPrefill } from '../CreateAccountWizard';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
  onAddAccount: () => void;
  onEditAccount: (account: Account) => void;
  onCreateAccounts: (platforms?: Platform[], prefill?: WizardPrefill) => void;
  /** Runs the in-app sign-up for profiles that are saved here but not created on the social yet. */
  onSignUp?: (accounts: Account[]) => void;
  /** For a profile made on the social outside the app: marks it Live and opens it to add the username and password. */
  onAlreadyCreated?: (account: Account) => void;
  onOpen: (platform: Platform, action: PlatformAction) => void;
  /** Saves a workspace rebuilt from a sign-in backup. */
  onRestore?: (next: Workspace, message: string) => Promise<boolean | undefined>;
  /** The brand page that is open (and its tab), kept by the app so other pages can open a brand. */
  openBrand?: OpenBrand;
  onOpenBrand?: (open: OpenBrand) => void;
  /** Saves workspace changes made on a brand's Content tab. */
  onSave?: (next: Workspace, message: string) => Promise<boolean | undefined>;
  /** Goes to where a connection is set up (inbox, posting, video makers). */
  onNavigate?: (view: View, section?: string) => void;
  /** Removes a profile from the app (asks first). It never deletes anything on the social. */
  onRemoveAccount?: (account: Account) => void;
  /** Removes a brand with all its profiles and videos from the app (asks first). */
  onRemoveBrand?: (brand: Brand) => void;
  /** Renames a brand and its profiles in the app (usernames on the socials are changed separately). */
  onRenameBrand?: (brand: Brand, name: string) => Promise<boolean | undefined>;
};
type BrandGroup = { key: string; brand: Brand; accounts: Account[] };
const ORDER = PLATFORMS.map((platform) => platform.id);
const byPlatform = (a: Account, b: Account) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform);

/** Each brand with its profiles in platform order. Accounts saved before brands existed are grouped by name. */
export function groupByBrand(workspace: Pick<Workspace, 'accounts'> & Partial<Workspace>): BrandGroup[] {
  const { brands, accounts } = migrateWorkspace(workspace);
  return brands.map((brand) => ({ key: brand.id, brand, accounts: accounts.filter((account) => account.brandId === brand.id).sort(byPlatform) }));
}

export default function AccountsPage({ workspace, loaded, busy, onAddAccount, onEditAccount, onCreateAccounts, onSignUp, onAlreadyCreated, onOpen, onRestore, openBrand, onOpenBrand, onSave, onRemoveAccount, onRemoveBrand, onRenameBrand, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'brands' | 'sign-ins' | 'connections'>('brands');
  // The open brand lives in the app when it passes one in, so the overview can open a brand's posts.
  const [localOpen, setLocalOpen] = useState<OpenBrand>(null);
  const opened = onOpenBrand ? openBrand ?? null : localOpen;
  const setOpened = onOpenBrand ?? setLocalOpen;
  const openId = opened?.id ?? null;
  const brandTab = opened?.tab ?? 'content';
  const showBrandTab = (tab: 'content' | 'accounts') => { if (opened) setOpened({ ...opened, tab }); };
  const [renaming, setRenaming] = useState<string | null>(null);
  const groups = useMemo(() => groupByBrand(workspace), [workspace]);
  const all = useMemo(() => groups.flatMap((group) => group.accounts), [groups]);
  const issues = useMemo(() => presenceIssues(all), [all]);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase().replace(/^@/, '');
    return groups.filter((group) => !text || group.brand.name.toLowerCase().includes(text)
      || group.accounts.some((account) => account.handle.toLowerCase().includes(text) || (account.displayName ?? '').toLowerCase().includes(text)));
  }, [groups, query]);
  const open = groups.find((group) => group.brand.id === openId);

  const actions = <>
    <button className="outline-button" disabled={!loaded} onClick={onAddAccount}><Plus size={16}/> Add an existing account</button>
    <button className="primary-button" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={16}/> New brand</button>
  </>;
  const tabs = <div className="segmented account-tabs" role="tablist" aria-label="Brands view"><button type="button" role="tab" aria-selected={tab === 'brands'} aria-pressed={tab === 'brands'} onClick={() => setTab('brands')}>Brands</button><button type="button" role="tab" aria-selected={tab === 'sign-ins'} aria-pressed={tab === 'sign-ins'} onClick={() => setTab('sign-ins')}>Sign-ins</button>{onNavigate && <button type="button" role="tab" aria-selected={tab === 'connections'} aria-pressed={tab === 'connections'} onClick={() => setTab('connections')}>Connections</button>}</div>;

  if (open && tab === 'brands') {
    const { brand, accounts } = open;
    const missing = PLATFORMS.filter((platform) => !accounts.some((account) => account.platform === platform.id));
    const notCreated = accounts.filter((account) => account.status !== 'active');
    const lead = accounts.find((account) => account.imagePath) ?? accounts[0];
    const baseEmail = lead?.signupEmail || DEFAULT_SIGNUP_EMAIL;
    return <>
      <button type="button" className="text-button back-link" onClick={() => { setOpened(null); setRenaming(null); }}><ArrowLeft size={15}/> All brands</button>
      <div className="brand-hero">
        <AccountAvatar account={lead} name={brand.name} size="lg"/>
        <div>{renaming === null
          ? <h1>{brand.name}{onRenameBrand && <button type="button" className="icon-button rename-brand" aria-label={`Rename ${brand.name}`} disabled={!loaded || busy} onClick={() => setRenaming(brand.name)}><Pencil size={15}/></button>}</h1>
          : <form className="inline-add rename-form" onSubmit={(event) => { event.preventDefault(); const name = renaming.trim(); if (name && onRenameBrand) void onRenameBrand(brand, name).then((ok) => { if (ok) setRenaming(null); }); }}>
            <label htmlFor="brand-name" className="sr-only">Brand name</label><input id="brand-name" autoFocus maxLength={120} value={renaming} onChange={(event) => setRenaming(event.target.value)}/>
            <button className="primary-button small-button" disabled={!renaming.trim() || busy}>Save</button><button type="button" className="ghost-button small-button" onClick={() => setRenaming(null)}>Cancel</button>
          </form>}<p>{accounts.length - notCreated.length} of {accounts.length} {accounts.length === 1 ? 'profile' : 'profiles'} live{missing.length ? ` · not on ${missing.map((platform) => platform.name).join(', ')} yet` : ''}</p></div>
        {notCreated.length > 1 && onSignUp && <button className="primary-button" disabled={!loaded || busy} onClick={() => onSignUp(notCreated)}><AppWindow size={15}/> Create all {notCreated.length} on the socials</button>}
      </div>
      <div className="segmented account-tabs brand-tabs" role="tablist" aria-label={`${brand.name} sections`}>
        <button type="button" role="tab" aria-selected={brandTab === 'content'} aria-pressed={brandTab === 'content'} onClick={() => showBrandTab('content')}>Posts</button>
        <button type="button" role="tab" aria-selected={brandTab === 'accounts'} aria-pressed={brandTab === 'accounts'} onClick={() => showBrandTab('accounts')}>Accounts</button>
      </div>
      {brandTab === 'content' ? (onSave ? <VideoLibrary workspace={workspace} loaded={loaded} busy={busy} onSave={onSave} onOpen={onOpen} brandId={brand.id}
        onManageSources={onNavigate ? () => onNavigate('settings', 'video-sources') : undefined} onConnectInstagram={() => showBrandTab('accounts')}/> : null) : <>
      <section className="brand-card" aria-label={`${brand.name} profiles`}>
        <div className="brand-section-title"><h2>Profiles</h2></div>
        <div className="account-rows">{accounts.map((account) => {
          const name = getPlatform(account.platform).name;
          const live = account.status === 'active';
          const problems = issues.filter((issue) => issue.accountId === account.id);
          return <div key={account.id} className="account-row-wrap">
            <button className="account-row" onClick={() => onEditAccount(account)}>
              <BrandMark platform={account.platform}/>
              <div><strong>{name}{account.handle && <span className="row-handle"> @{account.handle}</span>}</strong>{problems.map((problem) => <small key={problem.text} className="row-warning"><TriangleAlert size={12}/> {problem.text}</small>)}</div>
              <span className={`pill ${account.status}`}><span className="dot"/>{live ? 'Live' : 'Not created yet'}</span>
              <ChevronRight size={16}/>
            </button>
            {!live && onSignUp && <button className="outline-button small-button create-on" disabled={!loaded || busy} onClick={() => onSignUp([account])}><AppWindow size={14}/> Create on {name}</button>}
            {!live && onAlreadyCreated && <button className="ghost-button small-button already-made" disabled={!loaded || busy} onClick={() => onAlreadyCreated(account)}>I already made it</button>}
            {!live && onRemoveAccount && <button className="icon-button remove-profile" aria-label={`Delete ${name} profile`} title="Delete this profile from the app" disabled={!loaded || busy} onClick={() => onRemoveAccount(account)}><Trash2 size={15}/></button>}
          </div>;
        })}</div>
        {missing.length > 0 && <div className="add-platforms"><span>Add a profile on</span>{missing.map((platform) => {
          const plan = planPresence(all, platform.id, brand.name, baseEmail);
          return <button key={platform.id} className="chip-button" title={plan.reason} disabled={!loaded || busy} onClick={() => onCreateAccounts([platform.id], { brandId: brand.id, label: brand.name, handle: lead?.handle, displayName: lead?.displayName, bio: lead?.bio, website: lead?.website, signupEmail: baseEmail, imagePath: lead?.imagePath, birthday: lead?.birthday })}><Plus size={13}/> {platform.name}</button>;
        })}</div>}
      </section>
      {onNavigate && <div id="brand-connections"><Connections onNavigate={onNavigate} accounts={accounts} brands={[brand]} profilesOnly/></div>}
      <SignIns workspace={{ ...workspace, accounts }} busy={busy} onEdit={onEditAccount} onRestore={async () => false} showBackup={false}/>
      {onRemoveBrand && <div className="danger-zone"><button type="button" className="remove-button" disabled={!loaded || busy} onClick={() => onRemoveBrand(brand)}><Trash2 size={14}/> Delete {brand.name}</button><small>{accounts.some((account) => account.status === 'active') ? 'Live profiles stay on the socials; only their saved details here are removed.' : 'Removes the brand, its profiles and its videos from the app.'}</small></div>}
      </>}
    </>;
  }

  return <>
    <PageHeader eyebrow="Your brands" title="Brands" description="A brand is one account on every social. Open a brand to see its posts by category, and its accounts." actions={actions}/>
    {tabs}
    {tab === 'connections' && onNavigate ? <Connections onNavigate={onNavigate} accounts={all} brands={groups.map((group) => group.brand)}/> : tab === 'sign-ins' ? <SignIns workspace={workspace} busy={busy} onEdit={onEditAccount} onRestore={onRestore ?? (async () => false)}/> : groups.length === 0 ? <section className="card empty-state">
      <div className="empty-icon"><UsersRound size={22}/></div>
      <strong>No brands yet</strong>
      <p>New brand walks you through signing up on Instagram, TikTok, YouTube and X with one name, one description and one password. Already have an account? Add it so its sign-in is kept here. Moving to a new PC? Restore your backup under Sign-ins.</p>
      <div className="heading-buttons">{actions}</div>
    </section> : <>
      <div className="toolbar"><label className="search-input"><span className="sr-only">Search brands</span><Search size={15}/><input type="search" placeholder="Search brands or usernames" value={query} onChange={(event) => setQuery(event.target.value)}/></label></div>
      {shown.length === 0 && <p className="footnote">No brands match that search.</p>}
      <div className="brand-grid">{shown.map(({ brand, accounts }) => {
        const lead = accounts.find((account) => account.imagePath) ?? accounts[0];
        const live = accounts.filter((account) => account.status === 'active').length;
        return <button type="button" key={brand.id} className="brand-tile" aria-label={`Open ${brand.name}`} onClick={() => { setTab('brands'); setOpened({ id: brand.id, tab: 'content' }); }}>
          <AccountAvatar account={lead} name={brand.name} size="lg"/>
          <strong>{brand.name}</strong>
          <small>{live} of {accounts.length} live</small>
          <span className="tile-socials">{PLATFORMS.map((platform) => {
            const profile = accounts.find((account) => account.platform === platform.id);
            const state = !profile ? 'none' : profile.status === 'active' ? 'live' : 'planned';
            return <span key={platform.id} className={`tile-social ${state}`} title={`${platform.name}: ${state === 'live' ? 'Live' : state === 'planned' ? 'Not created yet' : 'No profile'}`}><BrandMark platform={platform.id} small/></span>;
          })}</span>
        </button>;
      })}</div>
    </>}
    {tab === 'brands' && <details className="more-tools"><summary>Open a social's own site</summary>
    <div className="platform-shortcuts" style={{ marginTop: 0 }}>{PLATFORMS.map((platform) => <div className="platform-shortcut" key={platform.id}>
      <BrandMark platform={platform.id} small/>
      <div><strong>{platform.name}</strong><small>{platform.description}</small></div>
      <button className="icon-button" aria-label={`Manage on ${platform.name}`} disabled={busy} onClick={() => onOpen(platform.id, 'manage')}><AppWindow size={16}/></button>
    </div>)}</div></details>}
  </>;
}
