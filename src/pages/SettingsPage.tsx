import { useEffect, useState } from 'react';
import { Bot, Building2, Mail, Palette, RefreshCw, RotateCw, Send, ShieldCheck, Sparkles, UserCheck, Users } from 'lucide-react';
import LookSettings from '../LookSettings';
import type { View, Workspace } from '../model';
import AyrshareSettings from '../AyrshareSettings';
import VideoSources from '../VideoSources';
import EmailSettings from '../EmailSettings';
import PartnerReviewSettings from '../PartnerReviewSettings';
import TeamSyncSettings from '../TeamSyncSettings';
import type { TeamSync } from '../useTeamSync';
import { DEFAULT_SETTINGS, listModels, loadSettings, saveSettings, type AssistantSettings } from '../assistant/grokClient';
import { PageHeader } from '../ui';

type Props = { workspace?: Workspace; onNavigate?: (view: View) => void; businessName: string; onBusinessNameChange: (value: string) => void; onSaveBusinessName: () => void; busy: boolean; loaded: boolean; /** Who manages app updates ("Ava"); null or absent when the app updates itself. */ updatesManagedBy?: string | null; teamSync?: TeamSync };

/** Ayrshare, Grok and Look first (the three things to set); the rest is kept below for sign-up and sharing. */
const SECTIONS = [
  { id: 'ayrshare', label: 'Ayrshare', icon: Send },
  { id: 'grok', label: 'Grok', icon: Sparkles },
  { id: 'look', label: 'Look', icon: Palette },
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'email', label: 'Sign-up email', icon: Mail },
  { id: 'partner-review', label: 'Partner review', icon: UserCheck },
  { id: 'team-sync', label: 'Shared accounts', icon: Users },
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
  return <div id="assistant">
    <h3><Bot size={15}/> Writing</h3>
    <p>Captions, hashtags, stories, profile bios, comment replies, the assistant and the Suggest buttons use this Grok model with the same xAI key. What it writes from is sent to xAI.</p>
    <div className={`status-line ${models?.length ? '' : 'off'}`}><span className="dot"/><span>{models === null ? 'Checking your xAI key…' : models.length ? `Grok is ready with ${models.length} ${models.length === 1 ? 'model' : 'models'}.` : 'No working xAI key yet. Add it as a Grok video source above.'}</span><button type="button" className="ghost-button small-button" disabled={checking} onClick={() => void check()}><RefreshCw size={14}/> Check</button></div>
    <label htmlFor="settings-model">Model</label>
    {models?.length ? <select id="settings-model" value={available ? settings.model : ''} onChange={(event) => update({ ...settings, model: event.target.value })}>
      {!available && <option value="" disabled>{settings.model} (not available)</option>}
      {models.map((model) => <option key={model} value={model}>{model}{model === DEFAULT_SETTINGS.model ? ' (default)' : ''}</option>)}
    </select> : <input id="settings-model" value={settings.model} onChange={(event) => update({ ...settings, model: event.target.value })}/>}
  </div>;
}

/** The section in view, so the left list shows where you are while scrolling. */
function useSectionInView() {
  const [active, setActive] = useState(SECTIONS[0].id);
  useEffect(() => {
    const scroller = document.querySelector('.main') ?? window;
    function update() {
      let current = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top < 160) current = id;
      }
      setActive(current);
    }
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true });
    return () => { scroller.removeEventListener('scroll', update); window.removeEventListener('scroll', update); };
  }, []);
  return [active, setActive] as const;
}

export default function SettingsPage({ workspace, onNavigate, businessName, onBusinessNameChange, onSaveBusinessName, busy, loaded, updatesManagedBy, teamSync }: Props) {
  const [active, setActive] = useSectionInView();
  return <>
    <PageHeader eyebrow="Make it yours" title="Settings" description={`Three things to set: Ayrshare for posting, Grok for videos and writing, and how the app looks. ${updatesManagedBy ? `Updates are managed by ${updatesManagedBy}.` : 'App updates have their own page.'}`}/>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">{SECTIONS.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={active === id ? 'active' : ''} aria-current={active === id ? 'location' : undefined}
        onClick={(event) => { event.preventDefault(); setActive(id); document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }}><Icon size={16}/>{label}</a>)}</nav>
      <div className="settings-stack">
        <AyrshareSettings workspace={workspace} onGo={onNavigate}/>
        <section className="settings-card" id="grok">
          <h2><Sparkles size={17}/> Grok</h2>
          <h3>Videos</h3>
          <p>Grok Imagine makes the videos (Kling too, if you add it). Each source has its own name and API key, checked with the provider and kept in Windows Credential Manager.</p>
          <VideoSources/>
          <AssistantSettingsCard/>
        </section>
        <LookSettings/>
        <h2 className="settings-more">More</h2>
        <form className="settings-card" id="workspace" onSubmit={(event) => { event.preventDefault(); onSaveBusinessName(); }}>
          <h2><Building2 size={17}/> Workspace</h2>
          <p>The business name shown in the sidebar. It's only for you here and doesn't change anything on a platform.</p>
          <label htmlFor="business">Business or LLC name</label>
          <input id="business" value={businessName} maxLength={120} onChange={(event) => onBusinessNameChange(event.target.value)} placeholder="e.g. Soft Wings LLC"/>
          <button className="primary-button" disabled={busy || !loaded}>Save changes</button>
        </form>
        <EmailSettings/>
        <PartnerReviewSettings/>
        {teamSync && <TeamSyncSettings sync={teamSync}/>}
        {updatesManagedBy && <section className="settings-card" id="updates"><h2><RotateCw size={17}/> Updates</h2><p className="footnote">Updates managed by {updatesManagedBy}.</p></section>}
        <div className="privacy-note"><ShieldCheck size={18}/><span>Your workspace is stored on this PC{teamSync?.status?.enabled ? ' and shared, encrypted, with your partner' : ''}. Passwords live in Windows Credential Manager and are only shown when you ask.</span></div>
      </div>
    </div>
  </>;
}
