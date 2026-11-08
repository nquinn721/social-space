import { useMemo, useState } from 'react';
import { AppWindow, ChevronRight, Plus, Search, TriangleAlert, UserPlus, UsersRound } from 'lucide-react';
import { getPlatform, PLATFORMS, type Account, type Brand, type Platform, type PlatformAction, type Workspace } from '../model';
import { migrateWorkspace, planPresence, presenceIssues } from '../brands';
import { AccountAvatar, BrandMark, PageHeader } from '../ui';
import '../brands.css';
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
  onOpen: (platform: Platform, action: PlatformAction) => void;
};
type Filter = 'all' | Platform;
type BrandGroup = { key: string; brand: Brand; accounts: Account[] };
const ORDER = PLATFORMS.map((platform) => platform.id);
const byPlatform = (a: Account, b: Account) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform);

/** Each brand with its profiles in platform order. Accounts saved before brands existed are grouped by name. */
export function groupByBrand(workspace: Pick<Workspace, 'accounts'> & Partial<Workspace>): BrandGroup[] {
  const { brands, accounts } = migrateWorkspace(workspace);
  return brands.map((brand) => ({ key: brand.id, brand, accounts: accounts.filter((account) => account.brandId === brand.id).sort(byPlatform) }));
}

export default function AccountsPage({ workspace, loaded, busy, onAddAccount, onEditAccount, onCreateAccounts, onSignUp, onOpen }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupByBrand(workspace), [workspace]);
  const all = useMemo(() => groups.flatMap((group) => group.accounts), [groups]);
  const issues = useMemo(() => presenceIssues(all), [all]);
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase().replace(/^@/, '');
    const matches = (account: Account) => (filter === 'all' || account.platform === filter)
      && (!text || account.label.toLowerCase().includes(text) || account.handle.toLowerCase().includes(text) || (account.displayName ?? '').toLowerCase().includes(text));
    return groups.map((group) => ({ ...group, visible: group.accounts.filter(matches) })).filter((group) => group.visible.length > 0);
  }, [groups, filter, query]);

  const actions = <>
    <button className="outline-button" disabled={!loaded} onClick={onAddAccount}><Plus size={16}/> Add an account</button>
    <button className="primary-button" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={16}/> Create accounts</button>
  </>;

  return <>
    <PageHeader eyebrow="Your presence" title="Accounts" description="Each brand and its profile on every social. Profiles marked Not created yet are only saved here; create them on the social in one click." actions={workspace.accounts.length ? actions : undefined}/>
    {workspace.accounts.length === 0 ? <section className="card empty-state">
      <div className="empty-icon"><UsersRound size={22}/></div>
      <strong>No accounts yet</strong>
      <p>Create accounts walks you through signing up on Instagram, TikTok, YouTube and X with one name, one description and one password. Already have accounts? Add them here to keep their sign-in details together.</p>
      <div className="heading-buttons">{actions}</div>
    </section> : <>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter accounts by social">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <span>{workspace.accounts.length}</span></button>
          {PLATFORMS.map((platform) => <button type="button" key={platform.id} aria-pressed={filter === platform.id} onClick={() => setFilter(platform.id)}>{platform.name} <span>{workspace.accounts.filter((account) => account.platform === platform.id).length}</span></button>)}
        </div>
        <label className="search-input"><span className="sr-only">Search accounts</span><Search size={15}/><input type="search" placeholder="Search by name or handle" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
      </div>
      <div className="brand-list">
        {shown.length === 0 && <p className="footnote">No accounts match. Try another filter or search.</p>}
        {shown.map(({ key, brand, accounts, visible }) => {
          const missing = PLATFORMS.filter((platform) => !accounts.some((account) => account.platform === platform.id));
          const notCreated = accounts.filter((account) => account.status !== 'active');
          const lead = accounts.find((account) => account.imagePath) ?? accounts[0];
          const handles = [...new Set(accounts.map((account) => account.handle).filter(Boolean))];
          const baseEmail = lead?.signupEmail || DEFAULT_SIGNUP_EMAIL;
          return <section className="brand-card" key={key} aria-label={brand.name}>
            <div className="brand-card-head">
              <AccountAvatar account={lead} name={brand.name} size="lg"/>
              <div><h2>{brand.name}</h2><p>{handles.length ? handles.map((handle) => `@${handle}`).join(', ') : 'No username yet'} · {accounts.length - notCreated.length} of {accounts.length} live</p></div>
              {notCreated.length > 1 && onSignUp ? <button className="primary-button small-button" disabled={!loaded || busy} onClick={() => onSignUp(notCreated)}><AppWindow size={14}/> Create all {notCreated.length} on the socials</button>
                : <div className="brand-platforms">{accounts.map((account) => <BrandMark key={account.id} platform={account.platform} small/>)}</div>}
            </div>
            <div className="account-rows">{visible.map((account) => {
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
              </div>;
            })}</div>
            {missing.length > 0 && <div className="add-platforms"><span>Add a profile on</span>{missing.map((platform) => {
              const plan = planPresence(all, platform.id, brand.name, baseEmail);
              return <button key={platform.id} className="chip-button" title={plan.reason} disabled={!loaded || busy} onClick={() => onCreateAccounts([platform.id], { brandId: brand.id, label: brand.name, handle: lead?.handle, displayName: lead?.displayName, bio: lead?.bio, website: lead?.website, signupEmail: baseEmail, imagePath: lead?.imagePath, birthday: lead?.birthday })}><Plus size={13}/> {platform.name}</button>;
            })}</div>}
          </section>;
        })}
      </div>
    </>}
    <details className="more-tools"><summary>Open a social's own site</summary>
    <div className="platform-shortcuts" style={{ marginTop: 0 }}>{PLATFORMS.map((platform) => <div className="platform-shortcut" key={platform.id}>
      <BrandMark platform={platform.id} small/>
      <div><strong>{platform.name}</strong><small>{platform.description}</small></div>
      <button className="icon-button" aria-label={`Manage on ${platform.name}`} disabled={busy} onClick={() => onOpen(platform.id, 'manage')}><AppWindow size={16}/></button>
    </div>)}</div></details>
  </>;
}
