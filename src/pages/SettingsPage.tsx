import { useEffect, useState } from 'react';
import { Bot, Building2, Clapperboard, KeyRound, Mail, RefreshCw, RotateCw, ShieldCheck, UserCheck, Users } from 'lucide-react';
import VideoSources from '../VideoSources';
import EmailSettings from '../EmailSettings';
import PartnerReviewSettings from '../PartnerReviewSettings';
import TeamSyncSettings from '../TeamSyncSettings';
import DeveloperAccounts from '../DeveloperAccounts';
import type { TeamSync } from '../useTeamSync';
import { DEFAULT_SETTINGS, listModels, loadSettings, saveSettings, type AssistantSettings } from '../assistant/grokClient';
import { PageHeader } from '../ui';

type Props = { businessName: string; onBusinessNameChange: (value: string) => void; onSaveBusinessName: () => void; busy: boolean; loaded: boolean; /** Who manages app updates ("Ava"); null or absent when the app updates itself. */ updatesManagedBy?: string | null; teamSync?: TeamSync };

const SECTIONS = [
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'developer-accounts', label: 'Developer accounts', icon: KeyRound },
  { id: 'email', label: 'Email inbox', icon: Mail },
  { id: 'partner-review', label: 'Partner review', icon: UserCheck },
  { id: 'team-sync', label: 'Shared accounts', icon: Users },
  { id: 'video-sources', label: 'Video sources', icon: Clapperboard },
  { id: 'assistant', label: 'Assistant', icon: Bot },
];

function AssistantSettingsCard() {
  const [settings, setSettings] = useState<AssistantSettings>(loadSettings);
  const [models, setModels] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try { setModels(await listModels()); } catch { setModels([]); } finally { setChecking(false); }
  }
  useEffect(() => { void check(); }, []);
  function update(next: AssistantSettings) { setSettings(next); saveSettings(next); }
  const available = models?.includes(settings.model);
  return <section className="settings-card" id="assistant">
    <h2><Bot size={17}/> Assistant</h2>
    <p>The assistant, the Suggest buttons and the profile picture maker use Grok from xAI with the key saved under Video sources. Prompts and the workspace details the assistant reads are sent to xAI.</p>
    <div className={`status-line ${models?.length ? '' : 'off'}`}><span className="dot"/><span>{models === null ? 'Checking your xAI key…' : models.length ? `Grok is ready with ${models.length} ${models.length === 1 ? 'model' : 'models'}.` : 'No working xAI key. Add a Grok source under Video sources.'}</span><button type="button" className="ghost-button small-button" disabled={checking} onClick={() => void check()}><RefreshCw size={14}/> Check</button></div>
    <label htmlFor="settings-model">Model</label>
    {models?.length ? <select id="settings-model" value={available ? settings.model : ''} onChange={(event) => update({ ...settings, model: event.target.value })}>
      {!available && <option value="" disabled>{settings.model} (not available)</option>}
      {models.map((model) => <option key={model} value={model}>{model}{model === DEFAULT_SETTINGS.model ? ' (default)' : ''}</option>)}
    </select> : <input id="settings-model" value={settings.model} onChange={(event) => update({ ...settings, model: event.target.value })}/>}
  </section>;
}

export default function SettingsPage({ businessName, onBusinessNameChange, onSaveBusinessName, busy, loaded, updatesManagedBy, teamSync }: Props) {
  return <>
    <PageHeader eyebrow="Make it yours" title="Settings" description={`Your workspace, inbox, video sources and assistant. ${updatesManagedBy ? `Updates are managed by ${updatesManagedBy}.` : 'App updates have their own page.'}`}/>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">{SECTIONS.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} onClick={(event) => { event.preventDefault(); document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}><Icon size={16}/>{label}</a>)}</nav>
      <div className="settings-stack">
        <form className="settings-card" id="workspace" onSubmit={(event) => { event.preventDefault(); onSaveBusinessName(); }}>
          <h2><Building2 size={17}/> Workspace</h2>
          <p>The business name shown in the sidebar and on the overview. It's only for you here and doesn't change anything on a platform.</p>
          <label htmlFor="business">Business or LLC name</label>
          <input id="business" value={businessName} maxLength={120} onChange={(event) => onBusinessNameChange(event.target.value)} placeholder="e.g. Soft Wings LLC"/>
          <button className="primary-button" disabled={busy || !loaded}>Save changes</button>
        </form>
        <DeveloperAccounts/>
        <EmailSettings/>
        <PartnerReviewSettings/>
        {teamSync && <TeamSyncSettings sync={teamSync}/>}
        <section className="settings-card" id="video-sources">
          <h2><Clapperboard size={17}/> Video sources</h2>
          <p>AI video providers you generate with, each under its own name and API key. Keys are checked with the provider and stored in Windows Credential Manager.</p>
          <VideoSources/>
        </section>
        <AssistantSettingsCard/>
        {updatesManagedBy && <section className="settings-card" id="updates"><h2><RotateCw size={17}/> Updates</h2><p className="footnote">Updates managed by {updatesManagedBy}.</p></section>}
        <div className="privacy-note"><ShieldCheck size={18}/><span>Your workspace is stored on this PC{teamSync?.status?.enabled ? ' and shared, encrypted, with your partner' : ''}. Passwords live in Windows Credential Manager and are only shown when you ask.</span></div>
      </div>
    </div>
  </>;
}
