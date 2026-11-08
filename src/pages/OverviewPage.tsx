import { useEffect, useState } from 'react';
import { Bot, Check, ChevronRight, Mail, Plus, Sparkles, UserPlus } from 'lucide-react';
import { ChannelOverview } from '../ChannelManagement';
import InboxList from '../InboxList';
import { emailConnection } from '../emailService';
import { listModels, loadSettings } from '../assistant/ollamaClient';
import { accountCountLabel, PLATFORMS, type Platform, type View, type Workspace } from '../model';
import { BrandMark } from '../ui';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  onNavigate: (view: View, section?: string) => void;
  onCreateAccounts: (platforms?: Platform[]) => void;
  onAddAccount: () => void;
  onOpenAssistant: () => void;
};

/** Whether the inbox and the local model are ready; null while still checking. */
function useConnections() {
  const [email, setEmail] = useState<boolean | null>(null);
  const [model, setModel] = useState<boolean | null>(null);
  useEffect(() => {
    emailConnection().then((value) => setEmail(Boolean(value))).catch(() => setEmail(false));
    const settings = loadSettings();
    listModels(settings).then((models) => setModel(models.length > 0)).catch(() => setModel(false));
  }, []);
  return { email, model };
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export default function OverviewPage({ workspace, loaded, onNavigate, onCreateAccounts, onAddAccount, onOpenAssistant }: Props) {
  const { email, model } = useConnections();
  const brands = workspace.brands?.length ?? new Set(workspace.accounts.map((account) => account.label.trim().toLowerCase())).size;
  const live = workspace.accounts.filter((account) => account.status === 'active').length;
  const platformsInUse = new Set(workspace.accounts.filter((account) => account.status === 'active').map((account) => account.platform)).size;
  const steps = [
    { id: 'name', done: Boolean(workspace.businessName.trim()), title: 'Name your workspace', detail: 'Shown across the app so you know where you are.', action: () => onNavigate('settings', 'workspace'), label: 'Add name' },
    { id: 'email', done: email === true, title: 'Connect your inbox', detail: 'So verification codes show up here during sign-up.', action: () => onNavigate('settings', 'email'), label: 'Connect' },
    { id: 'model', done: model === true, title: 'Set up the assistant', detail: 'Runs on this PC with Ollama. Suggests names and descriptions.', action: () => onNavigate('settings', 'assistant'), label: 'Set up' },
    { id: 'accounts', done: workspace.accounts.length > 0, title: 'Create your first accounts', detail: 'One form, every social, one shared password.', action: () => onCreateAccounts(), label: 'Start' },
  ];
  const done = steps.filter((step) => step.done).length;

  return <>
    <div className="page-heading">
      <div><p className="greeting">{greeting()}</p><h1>{workspace.businessName.trim() || 'Your workspace'}</h1><p>Everything social, all in one place.</p></div>
      <div className="heading-buttons">
        <button className="outline-button" disabled={!loaded} onClick={onAddAccount}><Plus size={16}/> Add an account</button>
        <button className="primary-button" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={16}/> Create accounts</button>
      </div>
    </div>

    <div className="stat-grid">
      <div className="stat"><span>Brands</span><strong>{brands}</strong><small>Names you've set up</small></div>
      <div className="stat"><span>Accounts</span><strong>{workspace.accounts.length}</strong><small>{live} live, {workspace.accounts.length - live} planned</small></div>
      <div className="stat"><span>Platforms in use</span><strong>{platformsInUse}<small style={{ display: 'inline', fontSize: 15 }}> / {PLATFORMS.length}</small></strong><small>With a live account</small></div>
      <div className="stat"><span>Channels</span><strong>{workspace.channels.length}</strong><small>Where you publish</small></div>
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

        <section aria-label="Your platforms">
          <div className="section-heading"><div><h2>Your platforms</h2><p>Create a new account or see the ones you have.</p></div><button className="text-button" onClick={() => onNavigate('accounts')}>All accounts <ChevronRight size={15}/></button></div>
          <div className="platform-tiles">{PLATFORMS.map((platform) => {
            const accounts = workspace.accounts.filter((account) => account.platform === platform.id);
            return <div className="platform-tile" key={platform.id}>
              <BrandMark platform={platform.id}/>
              <div><strong>{platform.name}</strong><small>{accounts.length ? accountCountLabel(accounts.length) : platform.description}</small></div>
              <button className="ghost-button small-button" disabled={!loaded} onClick={() => onCreateAccounts([platform.id])}><Plus size={14}/> {platform.id === 'youtube' ? 'Channel' : 'Account'}</button>
            </div>;
          })}</div>
        </section>

        <ChannelOverview workspace={workspace} onView={() => onNavigate('channels')}/>
      </div>

      <div className="overview-col">
        <section className="card" aria-label="Quick actions">
          <div className="card-title"><h2>Quick actions</h2></div>
          <div className="quick-actions">
            <button className="quick-action" disabled={!loaded} onClick={() => onCreateAccounts()}><UserPlus size={18}/><div><strong>Create accounts</strong><small>Sign up on every social in one pass</small></div><ChevronRight size={16}/></button>
            <button className="quick-action" onClick={() => onNavigate('inbox')}><Mail size={18}/><div><strong>Check verification codes</strong><small>Newest mail from your inbox</small></div><ChevronRight size={16}/></button>
            <button className="quick-action" onClick={onOpenAssistant}><Bot size={18}/><div><strong>Ask the assistant</strong><small>Draft profiles, find codes, post to X</small></div><ChevronRight size={16}/></button>
            <button className="quick-action" onClick={() => onNavigate('creative')}><Sparkles size={18}/><div><strong>Creative tools</strong><small>Make videos with Kling AI</small></div><ChevronRight size={16}/></button>
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
