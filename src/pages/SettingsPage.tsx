import { useEffect, useState } from 'react';
import { Bot, Building2, Clapperboard, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import VideoSources from '../VideoSources';
import EmailSettings from '../EmailSettings';
import { DEFAULT_SETTINGS, listModels, loadSettings, saveSettings, type AssistantSettings } from '../assistant/ollamaClient';
import { PageHeader } from '../ui';

type Props = { businessName: string; onBusinessNameChange: (value: string) => void; onSaveBusinessName: () => void; busy: boolean; loaded: boolean };

const SECTIONS = [
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'email', label: 'Email inbox', icon: Mail },
  { id: 'video-sources', label: 'Video sources', icon: Clapperboard },
  { id: 'assistant', label: 'Assistant', icon: Bot },
];

function AssistantSettingsCard() {
  const [settings, setSettings] = useState<AssistantSettings>(loadSettings);
  const [models, setModels] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  async function check(current = settings) {
    setChecking(true);
    try { setModels(await listModels(current)); } catch { setModels([]); } finally { setChecking(false); }
  }
  useEffect(() => { void check(); }, []);
  function update(next: AssistantSettings) { setSettings(next); saveSettings(next); }
  const installed = models?.includes(settings.model);
  return <section className="settings-card" id="assistant">
    <h2><Bot size={17}/> Assistant</h2>
    <p>The assistant and the Suggest button in Create accounts use Ollama on this PC. Nothing leaves your computer.</p>
    <div className={`status-line ${models?.length ? '' : 'off'}`}><span className="dot"/><span>{models === null ? 'Checking Ollama…' : models.length ? `Ollama is running with ${models.length} ${models.length === 1 ? 'model' : 'models'}.` : 'Ollama is not running or has no models.'}</span><button type="button" className="ghost-button small-button" disabled={checking} onClick={() => void check()}><RefreshCw size={14}/> Check</button></div>
    <label htmlFor="settings-model">Model</label>
    {models?.length ? <select id="settings-model" value={installed ? settings.model : ''} onChange={(event) => update({ ...settings, model: event.target.value })}>
      {!installed && <option value="" disabled>{settings.model} (not installed)</option>}
      {models.map((model) => <option key={model} value={model}>{model}</option>)}
    </select> : <input id="settings-model" value={settings.model} onChange={(event) => update({ ...settings, model: event.target.value })}/>}
    <label htmlFor="settings-url">Ollama address</label>
    <input id="settings-url" value={settings.baseUrl} onChange={(event) => update({ ...settings, baseUrl: event.target.value })} onBlur={() => void check()}/>
    <label className="check-row"><input type="checkbox" checked={settings.think} onChange={(event) => update({ ...settings, think: event.target.checked })}/> Let the model think before answering (slower, sometimes smarter)</label>
    {models !== null && !installed && <p className="footnote">To install the default model, run <code>ollama pull {DEFAULT_SETTINGS.model}</code> in a terminal.</p>}
  </section>;
}

export default function SettingsPage({ businessName, onBusinessNameChange, onSaveBusinessName, busy, loaded }: Props) {
  return <>
    <PageHeader eyebrow="Make it yours" title="Settings" description="Your workspace, inbox, video sources and assistant. App updates have their own page."/>
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
        <EmailSettings/>
        <section className="settings-card" id="video-sources">
          <h2><Clapperboard size={17}/> Video sources</h2>
          <p>AI video providers you generate with, each under its own name and API key. Keys are checked with the provider and stored in Windows Credential Manager.</p>
          <VideoSources/>
        </section>
        <AssistantSettingsCard/>
        <div className="privacy-note"><ShieldCheck size={18}/><span>Your workspace is stored on this PC. Passwords live in Windows Credential Manager and are only shown when you ask.</span></div>
      </div>
    </div>
  </>;
}
