import { useMemo, useState } from 'react';
import { AppWindow, ArrowLeft, Link2, Pencil, Search, Trash2, UserPlus, UsersRound, Wand2 } from 'lucide-react';
import VideoLibrary from '../VideoLibrary';
import SeriesPanel from '../SeriesPanel';
import BrandSchedule from '../BrandSchedule';
import ResultsPage from './ResultsPage';
import { useAyrshare } from '../useAyrshare';
import { errorText } from '../ui';
import type { BrandTab, OpenBrand } from '../App';
import { createAccount, getPlatform, PLATFORMS, type Account, type Brand, type BrandImage, type Platform, type PlatformAction, type View, type Workspace } from '../model';
import { DEFAULT_SIGNUP_BIRTHDAY, emailTag, migrateWorkspace, planPresence, plusAddress, presenceIssues, sharesLogins } from '../brands';

import BrandAccounts, { type AccountRequest } from '../BrandAccounts';
import { brandToDo, useAllStatuses, useBrandStatuses, type SocialStatus } from '../brandStatus';
import BrandCard from '../BrandCard';
import BrandPicture, { BrandAvatar } from '../BrandPicture';
import BrandProfiles, { type ProfileDraft } from '../BrandProfiles';
import { BrandMark, PageHeader } from '../ui';
import '../brands.css';
import SignIns from '../SignIns';
import { DEFAULT_SIGNUP_EMAIL, type WizardPrefill } from '../CreateAccountWizard';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
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
  /** Goes to where something is set up (inbox, Settings → Ayrshare, video makers). */
  onNavigate?: (view: View, section?: string) => void;
  /** Removes a profile from the app (asks first). It never deletes anything on the social. */
  onRemoveAccount?: (account: Account) => void;
  /** Removes a brand with all its profiles and videos from the app (asks first). */
  onRemoveBrand?: (brand: Brand) => void;
  /** Renames a brand and its profiles in the app (usernames on the socials are changed separately). */
  onRenameBrand?: (brand: Brand, name: string) => Promise<boolean | undefined>;
  /** Opens on this tab of the brands list, e.g. Sign-ins. */
  startTab?: 'brands' | 'sign-ins';
};
type BrandGroup = { key: string; brand: Brand; accounts: Account[] };
const ORDER = PLATFORMS.map((platform) => platform.id);
const byPlatform = (a: Account, b: Account) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform);

/** Each brand with its profiles in platform order. Accounts saved before brands existed are grouped by name. */
export function groupByBrand(workspace: Pick<Workspace, 'accounts'> & Partial<Workspace>): BrandGroup[] {
  const { brands, accounts } = migrateWorkspace(workspace);
  return brands.map((brand) => ({ key: brand.id, brand, accounts: accounts.filter((account) => account.brandId === brand.id).sort(byPlatform) }));
}

export default function AccountsPage({ workspace, loaded, busy, onEditAccount, onCreateAccounts, onSignUp, onAlreadyCreated, onOpen, onRestore, openBrand, onOpenBrand, onSave, onRemoveAccount, onRemoveBrand, onRenameBrand, onNavigate, startTab }: Props) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'brands' | 'sign-ins'>(startTab ?? 'brands');
  // The open brand lives in the app when it passes one in, so the overview can open a brand's posts.
  const [localOpen, setLocalOpen] = useState<OpenBrand>(null);
  const opened = onOpenBrand ? openBrand ?? null : localOpen;
  const setOpened = onOpenBrand ?? setLocalOpen;
  const openId = opened?.id ?? null;
  const brandTab = opened?.tab ?? 'content';
  const showBrandTab = (tab: BrandTab) => { if (opened) setOpened({ ...opened, tab }); };
  const ayrshare = useAyrshare();
  const [linkError, setLinkError] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  // Migrated once, so accounts saved before brands existed keep the same brand on every read.
  const migrated = useMemo(() => { const moved = migrateWorkspace(workspace); return { ...workspace, brands: moved.brands, accounts: moved.accounts }; }, [workspace]);
  const groups = useMemo(() => groupByBrand(migrated), [migrated]);
  const all = useMemo(() => groups.flatMap((group) => group.accounts), [groups]);
  const issues = useMemo(() => presenceIssues(all), [all]);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase().replace(/^@/, '');
    return groups.filter((group) => !text || group.brand.name.toLowerCase().includes(text)
      || group.accounts.some((account) => account.handle.toLowerCase().includes(text) || (account.displayName ?? '').toLowerCase().includes(text)));
  }, [groups, query]);
  const open = groups.find((group) => group.brand.id === openId);
  const statuses = useBrandStatuses(migrated, open?.brand.id);
  const allStatuses = useAllStatuses(migrated);

  /** The brand's picture, saved with the brand so it syncs (brands made before brands were saved are added). */
  async function saveBrandImage(brand: Brand, image: BrandImage | undefined, message: string) {
    if (!onSave) return false;
    const known = workspace.brands.some((item) => item.id === brand.id);
    const brands = known ? workspace.brands.map((item) => item.id === brand.id ? { ...item, image } : item) : [...workspace.brands, { ...brand, image }];
    return onSave({ ...workspace, brands }, message);
  }
  async function saveAccountImage(account: Account, imageFile: string | undefined, message: string) {
    if (!onSave) return false;
    return onSave({ ...workspace, accounts: workspace.accounts.map((item) => item.id === account.id ? { ...item, imageFile } : item) }, message);
  }
  async function saveProfiles(drafts: ProfileDraft[], message: string) {
    if (!onSave) return false;
    const byId = new Map(drafts.map((draft) => [draft.id, draft]));
    return onSave({ ...workspace, accounts: workspace.accounts.map((item) => { const draft = byId.get(item.id); return draft ? { ...item, bio: draft.bio, keywords: draft.keywords } : item; }) }, message);
  }
  const [adding, setAdding] = useState(false);
  /** A chip on the brand page that links one social on Ayrshare: the Socials tab acts on it. */
  const [accountRequest, setAccountRequest] = useState<AccountRequest | undefined>();
  /** The wizard prepares each account's password and reports errors before opening sign-up. */
  function startSignUp(account: Account) {
    if (!onSignUp) return;
    onSignUp([account]);
  }
  /** One click: saves the brand's profile on this social, then opens its sign-up page filled in. */
  async function addSocial(group: BrandGroup, platform: Platform) {
    if (adding || !onSave) return;
    setAdding(true);
    try {
      const { brand, accounts } = group;
      const lead = accounts.find((account) => account.imagePath) ?? accounts[0];
      const base = lead?.signupEmail || DEFAULT_SIGNUP_EMAIL;
      // New independent social accounts use a brand-specific plus-address when supported.
      const plan = planPresence(all, platform, brand.name, sharesLogins(platform) ? base : plusAddress(base, emailTag(brand.name)));
      if (!plan.email) {
        onCreateAccounts([platform], { brandId: brand.id, label: brand.name, handle: emailTag(brand.name), signupEmail: base, displayName: lead?.displayName, bio: lead?.bio, website: lead?.website, imagePath: lead?.imagePath });
        return;
      }
      // New profiles take the brand's name as their username (numbers are added at sign-up if it is taken) and the sign-up birthday.
      const account: Account = { ...createAccount(platform, brand.name, emailTag(brand.name), 'planned', ''), brandId: brand.id,
        displayName: lead?.displayName || brand.name, bio: lead?.bio, website: lead?.website, signupEmail: plan.email, imagePath: lead?.imagePath, birthday: DEFAULT_SIGNUP_BIRTHDAY };
      const saved = await onSave({ ...workspace, accounts: [...workspace.accounts, account] }, `${getPlatform(platform).name} profile added to ${brand.name}.`);
      if (saved === false) return;
      startSignUp(account);
    } finally { setAdding(false); }
  }

  const actions = <button className="primary-button" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={16}/> New brand</button>;
  const tabs = <div className="segmented account-tabs" role="tablist" aria-label="Brands view"><button type="button" role="tab" aria-selected={tab === 'brands'} aria-pressed={tab === 'brands'} onClick={() => setTab('brands')}>Brands</button><button type="button" role="tab" aria-selected={tab === 'sign-ins'} aria-pressed={tab === 'sign-ins'} onClick={() => setTab('sign-ins')}>Sign-ins</button></div>;

  if (open && tab === 'brands') {
    const { brand, accounts } = open;
    /**
     * The one step that unblocks a social: make its profile, finish its sign-up, connect Ayrshare (Settings),
     * or open Accounts to set up posting, link it on Ayrshare or fix its login.
     */
    const fixStatus = (status: SocialStatus) => {
      const kind = status.action?.kind;
      if (kind === 'create' && onSave && onSignUp) void addSocial(open, status.platform);
      else if (kind === 'finish-signup' && status.account && onSignUp) startSignUp(status.account);
      else if ((kind === 'connect-ayrshare' || kind === 'x-keys') && onNavigate) onNavigate('settings', 'ayrshare');
      else {
        showBrandTab('accounts');
        if (kind === 'link') setAccountRequest({ platform: status.platform, kind: 'link', at: Date.now() });
      }
    };
    const notCreated = accounts.filter((account) => account.status !== 'active');
    const lead = accounts.find((account) => account.imagePath) ?? accounts[0];
    const baseEmail = lead?.signupEmail || DEFAULT_SIGNUP_EMAIL;
    const linked = ayrshare.brands[brand.id]?.socials?.linked ?? [];
    const todo = brandToDo(statuses);
    const linkSocials = () => {
      setLinkError('');
      if (!ayrshare.brands[brand.id]?.socials?.hasProfile) { showBrandTab('accounts'); return; }
      ayrshare.link(brand).catch((reason) => setLinkError(errorText(reason)));
    };
    const tabs: { id: BrandTab; label: string }[] = [{ id: 'content', label: 'Videos' }, ...(onSave ? [{ id: 'series' as const, label: 'Stories' }] : []), { id: 'schedule', label: 'Schedule' }, { id: 'results', label: 'Results' }, { id: 'accounts', label: todo?.kind === 'link' ? `Socials (${todo.platforms.length})` : 'Socials' }];
    return <>
      <button type="button" className="text-button back-link" onClick={() => { setOpened(null); setRenaming(null); }}><ArrowLeft size={15}/> All brands</button>
      <div className="brand-hero">
        <BrandAvatar brand={brand} lead={lead}/>
        <div>{renaming === null
          ? <h1>{brand.name}{onRenameBrand && <button type="button" className="icon-button rename-brand" aria-label={`Rename ${brand.name}`} disabled={!loaded || busy} onClick={() => setRenaming(brand.name)}><Pencil size={15}/></button>}</h1>
          : <form className="inline-add rename-form" onSubmit={(event) => { event.preventDefault(); const name = renaming.trim(); if (name && onRenameBrand) void onRenameBrand(brand, name).then((ok) => { if (ok) setRenaming(null); }); }}>
            <label htmlFor="brand-name" className="sr-only">Brand name</label><input id="brand-name" autoFocus maxLength={120} value={renaming} onChange={(event) => setRenaming(event.target.value)}/>
            <button className="primary-button small-button" disabled={!renaming.trim() || busy}>Save</button><button type="button" className="ghost-button small-button" onClick={() => setRenaming(null)}>Cancel</button>
          </form>}
          <p className="brand-linked"><span className="today-socials">{linked.map((item) => <BrandMark key={item.platform} platform={item.platform} small/>)}</span>
            {linked.length ? `${linked.length} ${linked.length === 1 ? 'social' : 'socials'} linked in Ayrshare` : 'No socials linked in Ayrshare yet'}
            {todo && <button type="button" className="status-chip tone-todo" onClick={() => showBrandTab('accounts')}><span className="dot"/>{todo.kind === 'link' ? `${todo.platforms.length} to link` : todo.label}</button>}</p></div>
        <div className="heading-buttons">
          <button className="outline-button" disabled={!loaded || busy} onClick={linkSocials}><Link2 size={15}/> Link socials</button>
          <button className="primary-button" disabled={!loaded} onClick={() => { showBrandTab('content'); window.setTimeout(() => document.querySelector<HTMLElement>('.make-video, .library-toolbar')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 50); }}><Wand2 size={15}/> Make a video</button>
        </div>
      </div>
      {linkError && <div className="error-message" role="alert">{linkError}</div>}
      <div className="segmented account-tabs brand-tabs" role="tablist" aria-label={`${brand.name} sections`}>
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={brandTab === item.id} aria-pressed={brandTab === item.id} onClick={() => showBrandTab(item.id)}>{item.label}</button>)}
      </div>
      {brandTab === 'schedule' ? <BrandSchedule workspace={workspace} brand={brand} onOpenBrand={(id, tab) => setOpened({ id, tab: tab ?? 'content' })}/>
      : brandTab === 'results' ? <ResultsPage workspace={workspace} brandId={brand.id} onOpenSettings={onNavigate ? () => onNavigate('settings', 'ayrshare') : undefined}/>
      : brandTab === 'series' && onSave ? <SeriesPanel workspace={workspace} brand={brand} loaded={loaded} busy={busy} onSave={onSave} onManageSources={onNavigate ? () => onNavigate('settings', 'grok') : undefined}/>
      : brandTab === 'content' ? (onSave ? <VideoLibrary workspace={workspace} loaded={loaded} busy={busy} onSave={onSave} onOpen={onOpen} brandId={brand.id}
        onManageSources={onNavigate ? () => onNavigate('settings', 'grok') : undefined} onShowAccounts={() => showBrandTab('accounts')}
        onCreateProfile={(platform) => { const status = statuses.find((item) => item.platform === platform); if (status) fixStatus(status); }}/> : null) : <>
      {notCreated.length > 1 && onSignUp && <div className="heading-buttons"><button className="primary-button" disabled={!loaded || busy} onClick={() => onSignUp(notCreated)}><AppWindow size={15}/> Create all {notCreated.length} on the socials</button></div>}
      <BrandAccounts workspace={migrated} brand={brand} accounts={accounts} loaded={loaded} busy={busy || adding} onEditAccount={onEditAccount}
        onSignUp={onSignUp ? (account) => startSignUp(account) : undefined} onAlreadyCreated={onAlreadyCreated} onRemoveAccount={onRemoveAccount}
        onAddSocial={onSave && onSignUp ? (platform) => void addSocial(open, platform) : undefined} onNavigate={onNavigate}
        addHint={(platform) => planPresence(all, platform, brand.name, baseEmail).reason} warnings={(account) => issues.filter((issue) => issue.accountId === account.id).map((issue) => issue.text)} request={accountRequest}/>
      {onSave && <BrandProfiles key={brand.id} brand={brand} accounts={accounts} busy={busy || !loaded} onSave={saveProfiles}/>}
      {onSave && <BrandPicture brand={brand} accounts={accounts} busy={busy} onNavigate={onNavigate} onSaveImage={(image, message) => saveBrandImage(brand, image, message)} onSaveAccountImage={(account, file, message) => saveAccountImage(account, file, message)}/>}
      {onRemoveBrand && <div className="danger-zone"><button type="button" className="remove-button" disabled={!loaded || busy} onClick={() => onRemoveBrand(brand)}><Trash2 size={14}/> Delete {brand.name}</button><small>{accounts.some((account) => account.status === 'active') ? 'Live profiles stay on the socials; only their saved details here are removed.' : 'Removes the brand, its profiles and its videos from the app.'}</small></div>}
      </>}
    </>;
  }

  return <>
    <PageHeader eyebrow="Your brands" title="Brands" description="Each brand is one Ayrshare profile. Its videos go to every social linked to it." actions={actions}/>
    {tabs}
    {tab === 'sign-ins' ? <SignIns workspace={workspace} busy={busy} onEdit={onEditAccount} onRestore={onRestore ?? (async () => false)}/> : groups.length === 0 ? <section className="card empty-state">
      <div className="empty-icon"><UsersRound size={22}/></div>
      <strong>No brands yet</strong>
      <p>New brand makes its Ayrshare profile, then you link its Instagram, Facebook, TikTok, YouTube and X. Moving to a new PC? Restore your backup under Sign-ins.</p>
      <div className="heading-buttons">{actions}</div>
    </section> : <>
      <div className="toolbar"><label className="search-input"><span className="sr-only">Search brands</span><Search size={15}/><input type="search" placeholder="Search brands or usernames" value={query} onChange={(event) => setQuery(event.target.value)}/></label></div>
      {shown.length === 0 && <p className="footnote">No brands match that search.</p>}
      <div className="brand-cards">{shown.map(({ brand, accounts }) => <BrandCard key={brand.id} brand={brand} accounts={accounts} workspace={workspace}
        statuses={allStatuses[brand.id] ?? []} onOpen={() => { setTab('brands'); setOpened({ id: brand.id, tab: 'content' }); }}/>)}
        {!query && <button type="button" className="brand-card new" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={20}/><strong>New brand</strong><small>Makes its Ayrshare profile, then you link its socials</small></button>}</div>
    </>}
  </>;
}
