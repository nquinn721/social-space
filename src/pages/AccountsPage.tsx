import { useMemo, useState } from 'react';
import { AppWindow, ChevronRight, Plus, Search, UserPlus, UsersRound } from 'lucide-react';
import { getPlatform, PLATFORMS, type Account, type Platform, type PlatformAction, type Workspace } from '../model';
import { AccountAvatar, BrandMark, PageHeader } from '../ui';
import type { WizardPrefill } from '../CreateAccountWizard';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
  onAddAccount: () => void;
  onEditAccount: (account: Account) => void;
  onCreateAccounts: (platforms?: Platform[], prefill?: WizardPrefill) => void;
  onOpen: (platform: Platform, action: PlatformAction) => void;
};
type Filter = 'all' | Platform;
type Brand = { key: string; name: string; accounts: Account[] };

/** Accounts made together share a name, so they are shown as one brand with a row per social. */
export function groupByBrand(accounts: Account[]): Brand[] {
  const groups = new Map<string, Brand>();
  for (const account of accounts) {
    const key = account.label.trim().toLowerCase() || account.id;
    const group = groups.get(key) ?? { key, name: account.label.trim() || 'Untitled', accounts: [] };
    group.accounts.push(account);
    groups.set(key, group);
  }
  const order = PLATFORMS.map((platform) => platform.id);
  return [...groups.values()].map((group) => ({ ...group, accounts: group.accounts.sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform)) }));
}

const statusText = (account: Account) => `${account.handle ? `@${account.handle}` : 'No handle added'} · ${account.status === 'active' ? 'In use' : 'Planned'}`;

export default function AccountsPage({ workspace, loaded, busy, onAddAccount, onEditAccount, onCreateAccounts, onOpen }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const brands = useMemo(() => {
    const text = query.trim().toLowerCase().replace(/^@/, '');
    const shown = workspace.accounts.filter((account) => (filter === 'all' || account.platform === filter)
      && (!text || account.label.toLowerCase().includes(text) || account.handle.toLowerCase().includes(text) || (account.displayName ?? '').toLowerCase().includes(text)));
    return groupByBrand(shown);
  }, [workspace.accounts, filter, query]);
  const allBrands = useMemo(() => groupByBrand(workspace.accounts), [workspace.accounts]);

  const actions = <>
    <button className="outline-button" disabled={!loaded} onClick={onAddAccount}><Plus size={16}/> Add an account</button>
    <button className="primary-button" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={16}/> Create accounts</button>
  </>;

  return <>
    <PageHeader eyebrow="Your presence" title="Accounts" description="Every account, its sign-in details and its profile. Click one to see or change it." actions={workspace.accounts.length ? actions : undefined}/>
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
        {brands.length === 0 && <p className="footnote">No accounts match. Try another filter or search.</p>}
        {brands.map((brand) => {
          const full = allBrands.find((item) => item.key === brand.key) ?? brand;
          const missing = PLATFORMS.filter((platform) => !full.accounts.some((account) => account.platform === platform.id));
          const lead = full.accounts.find((account) => account.imagePath) ?? full.accounts[0];
          const handles = [...new Set(full.accounts.map((account) => account.handle).filter(Boolean))];
          return <section className="brand-card" key={brand.key} aria-label={brand.name}>
            <div className="brand-card-head">
              <AccountAvatar account={lead} name={brand.name} size="lg"/>
              <div><h2>{brand.name}</h2><p>{handles.length ? handles.map((handle) => `@${handle}`).join(', ') : 'No username yet'} · {full.accounts.length} {full.accounts.length === 1 ? 'social' : 'socials'}</p></div>
              <div className="brand-platforms">{full.accounts.map((account) => <BrandMark key={account.id} platform={account.platform} small/>)}</div>
            </div>
            <div className="account-rows">{brand.accounts.map((account) => <button key={account.id} className="account-row" onClick={() => onEditAccount(account)}>
              <BrandMark platform={account.platform}/>
              <div><strong>{getPlatform(account.platform).name}</strong><small>{statusText(account)}</small></div>
              <span className={`pill ${account.status}`}><span className="dot"/>{account.status === 'active' ? 'Live' : 'Planned'}</span>
              <ChevronRight size={16}/>
            </button>)}</div>
            {missing.length > 0 && <div className="add-platforms"><span>Also create on</span>{missing.map((platform) => <button key={platform.id} className="chip-button" disabled={!loaded || busy} onClick={() => onCreateAccounts([platform.id], { label: lead.label, handle: lead.handle, displayName: lead.displayName, bio: lead.bio, website: lead.website, signupEmail: lead.signupEmail, imagePath: lead.imagePath })}><Plus size={13}/> {platform.name}</button>)}</div>}
          </section>;
        })}
      </div>
    </>}
    <div className="section-heading" style={{ marginTop: 32 }}><div><h2>Open a platform</h2><p>Sign in and manage accounts in each platform's own window.</p></div></div>
    <div className="platform-shortcuts" style={{ marginTop: 0 }}>{PLATFORMS.map((platform) => <div className="platform-shortcut" key={platform.id}>
      <BrandMark platform={platform.id} small/>
      <div><strong>{platform.name}</strong><small>{platform.description}</small></div>
      <button className="icon-button" aria-label={`Manage on ${platform.name}`} disabled={busy} onClick={() => onOpen(platform.id, 'manage')}><AppWindow size={16}/></button>
    </div>)}</div>
  </>;
}
