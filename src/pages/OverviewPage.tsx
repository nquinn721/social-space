import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, ChevronRight, ClipboardCheck, Mail, Plus, Send, UserPlus } from 'lucide-react';
import { brandSocials } from '../VideoLibrary';
import { videoStage } from '../postDetails';
import InboxList from '../InboxList';
import { emailConnection } from '../emailService';
import { listModels } from '../assistant/grokClient';
import { getPlatform, type Platform, type View, type Workspace } from '../model';
import { BrandMark } from '../ui';
import { useSetupStatus } from '../setupService';
import { brandStatuses } from '../brandStatus';
import { migrateWorkspace } from '../brands';
import BrandCard, { postsToMake } from '../BrandCard';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  onNavigate: (view: View, section?: string) => void;
  /** Opens a brand's page on its posts. */
  onOpenBrand?: (brandId: string, tab?: 'content' | 'accounts') => void;
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

export default function OverviewPage({ workspace: saved, loaded, onNavigate, onOpenBrand, onCreateAccounts, onAddAccount, onOpenAssistant }: Props) {
  // Accounts saved before brands existed get their brand here too, as everywhere else.
  const workspace = useMemo(() => { const moved = migrateWorkspace(saved); return { ...saved, brands: moved.brands, accounts: moved.accounts }; }, [saved]);
  const openBrand = (id: string, tab: 'content' | 'accounts' = 'content') => onOpenBrand ? onOpenBrand(id, tab) : onNavigate('accounts');
  const { email, model } = useConnections();
  const steps = [
    { id: 'name', done: Boolean(workspace.businessName.trim()), title: 'Name your workspace', detail: 'Shown across the app so you know where you are.', action: () => onNavigate('settings', 'workspace'), label: 'Add name' },
    { id: 'email', done: email === true, title: 'Connect your inbox', detail: 'So verification codes show up here during sign-up.', action: () => onNavigate('settings', 'email'), label: 'Connect' },
    { id: 'model', done: model === true, title: 'Set up the assistant', detail: 'Uses Grok with your xAI key. Suggests names, descriptions and pictures.', action: () => onNavigate('settings', 'assistant'), label: 'Set up' },
    { id: 'accounts', done: workspace.accounts.length > 0, title: 'Create your first brand', detail: 'One form sets up its profile on every social.', action: () => onCreateAccounts(), label: 'Start' },
  ];
  const done = steps.filter((step) => step.done).length;
  // Still checking email and Grok: don't flash the setup card at people who are set up.
  const setupKnown = email !== null && model !== null;
  const status = useSetupStatus(workspace.accounts);
  const brands = workspace.brands ?? [];
  const boards = useMemo(() => brands.map((brand) => {
    const statuses = brandStatuses(workspace, brand.id, { connections: status.connections, passwords: status.passwords });
    return { brand, accounts: workspace.accounts.filter((account) => account.brandId === brand.id), statuses, posts: postsToMake(workspace, brand.id, statuses) };
  }), [workspace, brands, status.connections, status.passwords]);
  const toMake = boards.reduce((sum, board) => sum + board.posts.total, 0);
  const canGo = boards.reduce((sum, board) => sum + board.posts.now, 0);
  const attention = boards.flatMap((board) => board.statuses.filter((item) => !item.canPost && (item.tone === 'todo' || item.tone === 'problem')).map((item) => ({ ...item, brand: board.brand })));
  const live = workspace.accounts.filter((account) => account.status === 'active').length;
  const waitingBrands = boards.filter((board) => board.posts.total > 0).sort((a, b) => b.posts.now - a.posts.now);

  return <>
    <div className="page-heading">
      <div><p className="greeting">{greeting()}</p><h1>{workspace.businessName.trim() || 'Your workspace'}</h1>
        <p>{brands.length === 0 ? 'Start with a brand: one name, a profile on every social.' : toMake ? `${toMake} ${toMake === 1 ? 'post' : 'posts'} to make across ${brands.length} ${brands.length === 1 ? 'brand' : 'brands'}${canGo < toMake ? `, ${canGo} can go out now` : ''}.` : 'Every video is posted everywhere it can go.'}</p></div>
      <div className="heading-buttons">
        <button className="outline-button" disabled={!loaded} onClick={onAddAccount}><Plus size={16}/> Add an existing account</button>
        <button className="primary-button" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={16}/> New brand</button>
      </div>
    </div>

    {brands.length > 0 && <div className="stat-grid">
      <button type="button" className="stat stat-button" onClick={() => waitingBrands[0] && openBrand(waitingBrands[0].brand.id)} disabled={!waitingBrands.length}><span>Posts to make</span><strong>{toMake}</strong><small>{toMake ? `${canGo} ready to go out now` : 'All caught up'}</small></button>
      <div className="stat"><span>Needs attention</span><strong>{attention.length}</strong><small>{attention.length ? 'Socials that can\'t post yet' : 'Every profile can post'}</small></div>
      <div className="stat"><span>Brands</span><strong>{brands.length}</strong><small>{live} live {live === 1 ? 'profile' : 'profiles'}</small></div>
      <div className="stat"><span>Videos</span><strong>{workspace.videos?.length ?? 0}</strong><small>In {workspace.categories?.length ?? 0} {(workspace.categories?.length ?? 0) === 1 ? 'category' : 'categories'}</small></div>
    </div>}

    <div className="overview-grid">
      <div className="overview-col">
        {setupKnown && done < steps.length && <section className="card setup-card" aria-label="Get set up">
          <div className="card-title"><div><h2>Get set up</h2><p>{done} of {steps.length} done</p></div></div>
          <div className="setup-progress"><span style={{ width: `${(done / steps.length) * 100}%` }}/></div>
          <ul className="setup-list">{steps.map((step) => <li key={step.id} className={step.done ? 'done' : ''}>
            <span className="check-circle"><Check size={13} strokeWidth={3}/></span>
            <div><strong>{step.title}</strong><small>{step.detail}</small></div>
            {!step.done && <button className="outline-button small-button" disabled={step.id === 'accounts' && !loaded} onClick={step.action}>{step.label}</button>}
          </li>)}</ul>
        </section>}

        {attention.length > 0 && <section className="card" aria-label="Needs attention">
          <div className="card-title"><div><h2>Needs attention</h2><p>Fix these and every video can go out on them.</p></div></div>
          <div className="quick-actions">{attention.map((item) => <button key={`${item.brand.id}:${item.platform}`} className={`quick-action attention tone-${item.tone}`} onClick={() => openBrand(item.brand.id, 'accounts')}>
            <BrandMark platform={item.platform} small/><div><strong>{item.brand.name} · {getPlatform(item.platform).name}</strong><small>{item.detail}</small></div>
            <span className="status-chip"><span className="dot"/>{item.action?.label ?? item.label}</span>
          </button>)}</div>
        </section>}

        <section aria-label="Your brands">
          <div className="section-heading"><div><h2>Your brands</h2><p>Where each brand stands on every social.</p></div><button className="text-button" onClick={() => onNavigate('accounts')}>All brands <ChevronRight size={15}/></button></div>
          <div className="brand-cards">{boards.map((board) => <BrandCard key={board.brand.id} brand={board.brand} accounts={board.accounts} statuses={board.statuses} workspace={workspace} onOpen={() => openBrand(board.brand.id)}/>)}
            <button type="button" className="brand-card new" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={20}/><strong>New brand</strong><small>Walks you through every social</small></button>
          </div>
        </section>
      </div>

      <div className="overview-col">
        <section className="card" aria-label="Quick actions">
          <div className="card-title"><h2>Quick actions</h2></div>
          <div className="quick-actions">
            {waitingBrands.slice(0, 3).map((board) => <button key={board.brand.id} className="quick-action" onClick={() => openBrand(board.brand.id)}><Send size={18}/><div><strong>Post {board.brand.name}'s videos</strong><small>{board.posts.total} to make{board.posts.now < board.posts.total ? `, ${board.posts.now} ready now` : ''}</small></div><ChevronRight size={16}/></button>)}
            <button className="quick-action" onClick={() => onNavigate('inbox')}><Mail size={18}/><div><strong>Check verification codes</strong><small>{email === false ? 'Connect your inbox first' : 'Newest mail from your inbox'}</small></div><ChevronRight size={16}/></button>
            <button className="quick-action" onClick={() => onNavigate('accounts', 'setup')}><ClipboardCheck size={18}/><div><strong>What each social needs</strong><small>Profiles, logins and connections, per social</small></div><ChevronRight size={16}/></button>
            <button className="quick-action" onClick={onOpenAssistant}><Bot size={18}/><div><strong>Ask the assistant</strong><small>{model === false ? 'Add your xAI key under Settings first' : 'Draft posts, profiles and pictures with Grok'}</small></div><ChevronRight size={16}/></button>
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
