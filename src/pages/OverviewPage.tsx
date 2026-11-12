import { useEffect, useState } from 'react';
import { Bot, Check, ChevronRight, ClipboardCheck, Mail, Plus, UserPlus } from 'lucide-react';
import { brandSocials } from '../VideoLibrary';
import { videoStage } from '../postDetails';
import InboxList from '../InboxList';
import { emailConnection } from '../emailService';
import { listModels } from '../assistant/grokClient';
import { PLATFORMS, type Platform, type View, type Workspace } from '../model';
import { BrandMark } from '../ui';
import { useSetupStatus } from '../setupService';
import { openCount, platformName, setupNeeds } from '../setupNeeds';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  onNavigate: (view: View, section?: string) => void;
  /** Opens a brand's page on its posts. */
  onOpenBrand?: (brandId: string) => void;
  onCreateAccounts: (platforms?: Platform[]) => void;
  onAddAccount: () => void;
  onOpenAssistant: () => void;
};

/** Whether the inbox and Grok are ready; null while still checking. */
function useConnections() {
  const [email, setEmail] = useState<boolean | null>(null);
  const [model, setModel] = useState<boolean | null>(null);
  useEffect(() => {
    emailConnection().then((value) => setEmail(Boolean(value))).catch(() => setEmail(false));
    listModels().then((models) => setModel(models.length > 0)).catch(() => setModel(false));
  }, []);
  return { email, model };
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** Posts waiting for approval, per brand. */
export function postsToApprove(workspace: Workspace) {
  return workspace.brands.map((brand) => {
    const socials = brandSocials(workspace, brand.id);
    return { brand, count: (workspace.videos ?? []).filter((video) => video.brandId === brand.id && videoStage(video, socials) === 'review').length };
  }).filter((item) => item.count > 0);
}

export default function OverviewPage({ workspace, loaded, onNavigate, onOpenBrand, onCreateAccounts, onAddAccount, onOpenAssistant }: Props) {
  const waiting = postsToApprove(workspace);
  const openBrand = (id: string) => onOpenBrand ? onOpenBrand(id) : onNavigate('accounts');
  const { email, model } = useConnections();
  const brands = workspace.brands?.length ?? new Set(workspace.accounts.map((account) => account.label.trim().toLowerCase())).size;
  const live = workspace.accounts.filter((account) => account.status === 'active').length;
  const platformsInUse = new Set(workspace.accounts.filter((account) => account.status === 'active').map((account) => account.platform)).size;
  const steps = [
    { id: 'name', done: Boolean(workspace.businessName.trim()), title: 'Name your workspace', detail: 'Shown across the app so you know where you are.', action: () => onNavigate('settings', 'workspace'), label: 'Add name' },
    { id: 'email', done: email === true, title: 'Connect your inbox', detail: 'So verification codes show up here during sign-up.', action: () => onNavigate('settings', 'email'), label: 'Connect' },
    { id: 'model', done: model === true, title: 'Set up the assistant', detail: 'Uses Grok with your xAI key. Suggests names, descriptions and pictures.', action: () => onNavigate('settings', 'assistant'), label: 'Set up' },
    { id: 'accounts', done: workspace.accounts.length > 0, title: 'Create your first brand', detail: 'One form sets up its profile on every social.', action: () => onCreateAccounts(), label: 'Start' },
  ];
  const done = steps.filter((step) => step.done).length;
  const status = useSetupStatus(workspace.accounts);
  const needs = setupNeeds({ accounts: workspace.accounts, brands: workspace.brands ?? [], ...status, marks: workspace.setup ?? {} });
  const needed = openCount(needs);
  const checking = needs.some((group) => group.needs.some((need) => need.status === 'checking'));

  return <>
    <div className="page-heading">
      <div><p className="greeting">{greeting()}</p><h1>{workspace.businessName.trim() || 'Your workspace'}</h1><p>Everything social, all in one place.</p></div>
      <div className="heading-buttons">
        <button className="outline-button" disabled={!loaded} onClick={onAddAccount}><Plus size={16}/> Add an existing account</button>
        <button className="primary-button" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={16}/> New brand</button>
      </div>
    </div>

    <div className="stat-grid">
      <div className="stat"><span>Brands</span><strong>{brands}</strong><small>Names you've set up</small></div>
      <div className="stat"><span>Profiles</span><strong>{workspace.accounts.length}</strong><small>{live} live, {workspace.accounts.length - live} not created yet</small></div>
      <div className="stat"><span>Platforms in use</span><strong>{platformsInUse}<small style={{ display: 'inline', fontSize: 15 }}> / {PLATFORMS.length}</small></strong><small>With a live account</small></div>
      <div className="stat"><span>Videos</span><strong>{workspace.videos?.length ?? 0}</strong><small>In {workspace.categories?.length ?? 0} categories</small></div>
    </div>

    <div className="overview-grid">
      <div className="overview-col">
        {done < steps.length && <section className="card setup-card" aria-label="Get set up">
          <div className="card-title"><div><h2>Get set up</h2><p>{done} of {steps.length} done</p></div></div>
          <div className="setup-progress"><span style={{ width: `${(done / steps.length) * 100}%` }}/></div>
          <ul className="setup-list">{steps.map((step) => <li key={step.id} className={step.done ? 'done' : ''}>
            <span className="check-circle"><Check size={13} strokeWidth={3}/></span>
            <div><strong>{step.title}</strong><small>{step.detail}</small></div>
            {!step.done && <button className="outline-button small-button" disabled={step.id === 'accounts' && !loaded} onClick={step.action}>{step.label}</button>}
          </li>)}</ul>
        </section>}

        {needs.length > 0 && <section className="card" aria-label="Before you can post">
          <div className="card-title"><div><h2>Before you can post</h2><p>{needed ? `${needed} ${needed === 1 ? 'step' : 'steps'} left across your socials${checking ? ' (still checking)' : ''}.` : checking ? 'Checking…' : 'Every social is ready to post.'}</p></div></div>
          <div className="quick-actions">
            {needs.map((group) => <button key={group.platform} className="quick-action" onClick={() => onNavigate('accounts', 'setup')}>
              <BrandMark platform={group.platform} small/><div><strong>{platformName(group.platform)}</strong><small>{group.open ? `${group.open} ${group.open === 1 ? 'step' : 'steps'} left` : 'Ready'}</small></div><ChevronRight size={16}/>
            </button>)}
            <button className="quick-action" onClick={() => onNavigate('accounts', 'setup')}><ClipboardCheck size={18}/><div><strong>See what's needed</strong><small>Developer apps, reviews, plans, account settings and connections</small></div><ChevronRight size={16}/></button>
          </div>
        </section>}

        <section className="card" aria-label="Posts to approve">
          <div className="card-title"><h2>Posts to approve</h2></div>
          {waiting.length === 0 ? <p className="footnote">Nothing waiting. New videos show up here as posts, written for you, ready to check and approve.</p>
            : <div className="quick-actions">{waiting.map(({ brand, count }) => <button key={brand.id} className="quick-action" onClick={() => openBrand(brand.id)}><Check size={18}/><div><strong>{brand.name}</strong><small>{count} {count === 1 ? 'post' : 'posts'} to approve</small></div><ChevronRight size={16}/></button>)}</div>}
        </section>
        <section aria-label="Your brands">
          <div className="section-heading"><div><h2>Your brands</h2><p>Each brand is one account on every social.</p></div><button className="text-button" onClick={() => onNavigate('accounts')}>All brands <ChevronRight size={15}/></button></div>
          <div className="brand-grid">{(workspace.brands ?? []).map((brand) => {
            const profiles = workspace.accounts.filter((account) => account.brandId === brand.id);
            const liveHere = profiles.filter((account) => account.status === 'active').length;
            return <button type="button" key={brand.id} className="brand-tile" aria-label={`Open ${brand.name}`} onClick={() => openBrand(brand.id)}>
              <strong>{brand.name}</strong><small>{liveHere} of {profiles.length} live</small>
              <span className="tile-socials">{PLATFORMS.map((platform) => {
                const profile = profiles.find((account) => account.platform === platform.id);
                const state = !profile ? 'none' : profile.status === 'active' ? 'live' : 'planned';
                return <span key={platform.id} className={`tile-social ${state}`}><BrandMark platform={platform.id} small/></span>;
              })}</span>
            </button>;
          })}
            <button type="button" className="brand-tile new" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={20}/><strong>New brand</strong><small>Walks you through every social</small></button>
          </div>
        </section>

      </div>

      <div className="overview-col">
        <section className="card" aria-label="Quick actions">
          <div className="card-title"><h2>Quick actions</h2></div>
          <div className="quick-actions">
            <button className="quick-action" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={18}/><div><strong>New brand</strong><small>Set up its profile on every social in one pass</small></div><ChevronRight size={16}/></button>
            <button className="quick-action" onClick={() => onNavigate('inbox')}><Mail size={18}/><div><strong>Check verification codes</strong><small>Newest mail from your inbox</small></div><ChevronRight size={16}/></button>
            <button className="quick-action" onClick={onOpenAssistant}><Bot size={18}/><div><strong>Ask the assistant</strong><small>Draft profiles, find codes, post to X</small></div><ChevronRight size={16}/></button>
          </div>
        </section>
        {email && <section aria-label="Latest mail">
          <div className="section-heading"><div><h2>Latest mail</h2><p>Codes are pulled out so you can copy them.</p></div><button className="text-button" onClick={() => onNavigate('inbox')}>Open inbox <ChevronRight size={15}/></button></div>
          <InboxList compact limit={5}/>
        </section>}
      </div>
    </div>
  </>;
}
