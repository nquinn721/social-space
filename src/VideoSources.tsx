import { useEffect, useState, type FormEvent } from 'react';
import { AppWindow, BadgeCheck, Clapperboard, KeyRound, Pencil, Plus, RefreshCw, ShieldAlert, X as Close } from 'lucide-react';
import { addVideoSource, checkVideoSource, listVideoSources, openProviderKeys, removeVideoSource, renameVideoSource, type VideoProvider, type VideoSource } from './videoSourcesService';
import { MAX_SOURCE_NAME, PROVIDERS, PROVIDER_LIST } from './videoProviders';
import { errorText } from './ui';
import './videoSources.css';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function checkedLabel(checkedAt: number | null, now = Date.now()) {
  if (!checkedAt) return 'Not checked yet';
  const age = Math.max(0, now - checkedAt);
  if (age < MINUTE) return 'Checked just now';
  if (age < HOUR) return `Checked ${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `Checked ${Math.floor(age / HOUR)} h ago`;
  return `Checked ${new Date(checkedAt).toLocaleDateString()}`;
}

function creditsLabel(source: VideoSource) {
  if (source.creditsRemaining === null) return null;
  const units = Number.isInteger(source.creditsRemaining) ? source.creditsRemaining.toLocaleString() : source.creditsRemaining.toFixed(1);
  return `${units} units left`;
}

/** Next unused default name, e.g. "Kling", then "Kling 2". */
function defaultName(provider: VideoProvider, sources: VideoSource[]) {
  const base = PROVIDERS[provider].name.replace(/ AI$/, '');
  const taken = new Set(sources.map((source) => source.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; ; index++) if (!taken.has(`${base} ${index}`.toLowerCase())) return `${base} ${index}`;
}

function ProviderLogo({ provider, size = 'md' }: { provider: VideoProvider; size?: 'sm' | 'md' }) {
  return <span className={`provider-logo provider-${provider} ${size}`} aria-hidden="true"><img src={PROVIDERS[provider].logo} alt=""/></span>;
}

function SourceCard({ source, disabled, onChange, onRemoved, run }: { source: VideoSource; disabled: boolean; onChange: (next: VideoSource) => void; onRemoved: () => void; run: (action: () => Promise<void>) => Promise<void> }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(source.name);
  const [confirming, setConfirming] = useState(false);
  const provider = PROVIDERS[source.provider];
  const verified = source.status === 'verified';
  const rejected = source.status === 'rejected';
  function rename(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || name.trim() === source.name) { setRenaming(false); return; }
    void run(async () => { onChange(await renameVideoSource(source.id, name.trim())); setRenaming(false); });
  }
  return <article className={`source-card provider-${source.provider} ${source.status}`} aria-label={`${source.name}, ${provider.name}`}>
    <div className="source-top">
      {verified ? <ProviderLogo provider={source.provider}/> : <span className="provider-logo neutral" aria-hidden="true">{rejected ? <ShieldAlert size={20}/> : <Clapperboard size={20}/>}</span>}
      <div className="source-title">
        {renaming ? <form className="rename-form" onSubmit={rename}>
          <label className="sr-only" htmlFor={`rename-${source.id}`}>Source name</label>
          <input id={`rename-${source.id}`} autoFocus maxLength={MAX_SOURCE_NAME} value={name} onChange={(event) => setName(event.target.value)}/>
          <button className="primary-button small-button" disabled={disabled || !name.trim()}>Save</button>
          <button type="button" className="ghost-button small-button" aria-label="Cancel rename" onClick={() => { setName(source.name); setRenaming(false); }}><Close size={14}/></button>
        </form> : <h3>{source.name}</h3>}
        <span className="source-provider">{provider.name}</span>
      </div>
      {verified ? <span className="source-badge verified"><BadgeCheck size={14}/> Verified</span> : rejected ? <span className="source-badge rejected">Key rejected</span> : <span className="source-badge">Not checked</span>}
    </div>
    <div className="source-meta">
      {verified && creditsLabel(source) && <span className="source-credits">{creditsLabel(source)}</span>}
      <span>{checkedLabel(source.checkedAt)}</span>
    </div>
    {source.detail && <p className={`source-detail ${rejected ? 'bad' : ''}`}>{source.detail}</p>}
    {confirming ? <div className="source-actions confirm" role="group" aria-label={`Remove ${source.name}?`}>
      <span>Remove this source and delete its key from Credential Manager?</span>
      <button className="remove-button" disabled={disabled} onClick={() => void run(async () => { await removeVideoSource(source.id); onRemoved(); })}>Remove</button>
      <button className="ghost-button small-button" onClick={() => setConfirming(false)}>Cancel</button>
    </div> : <div className="source-actions">
      <button className={verified ? 'ghost-button small-button' : 'primary-button small-button'} disabled={disabled} onClick={() => void run(async () => onChange(await checkVideoSource(source.id)))}><RefreshCw size={14}/> {source.status === 'unchecked' ? 'Check key' : 'Check again'}</button>
      {!renaming && <button className="ghost-button small-button" disabled={disabled} onClick={() => setRenaming(true)}><Pencil size={14}/> Rename</button>}
      <button className="ghost-button small-button danger-text" disabled={disabled} onClick={() => setConfirming(true)}>Remove</button>
    </div>}
  </article>;
}

function AddSourceForm({ sources, disabled, onAdded, onCancel, run }: { sources: VideoSource[]; disabled: boolean; onAdded: (source: VideoSource) => void; onCancel?: () => void; run: (action: () => Promise<void>) => Promise<void> }) {
  const [provider, setProvider] = useState<VideoProvider>('kling');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const info = PROVIDERS[provider];
  const placeholder = defaultName(provider, sources);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!key.trim()) return;
    void run(async () => { onAdded(await addVideoSource(name.trim() || placeholder, provider, key.trim())); setKey(''); setName(''); });
  }
  return <form className="add-source" onSubmit={submit}>
    <fieldset className="provider-picker">
      <legend>Provider</legend>
      {PROVIDER_LIST.map((item) => <label key={item.id} className={`provider-option provider-${item.id} ${provider === item.id ? 'selected' : ''}`}>
        <input type="radio" name="video-provider" value={item.id} checked={provider === item.id} onChange={() => setProvider(item.id)}/>
        <ProviderLogo provider={item.id} size="sm"/><span><strong>{item.name}</strong><small>{item.tagline}</small></span>
      </label>)}
      <span className="provider-soon">More providers coming soon</span>
    </fieldset>
    <label htmlFor="source-name">Source name</label>
    <input id="source-name" maxLength={MAX_SOURCE_NAME} value={name} placeholder={placeholder} onChange={(event) => setName(event.target.value)}/>
    <label htmlFor="source-key">{info.name} API key</label>
    <input id="source-key" type="password" autoComplete="off" spellCheck={false} value={key} placeholder="Paste your API key" onChange={(event) => setKey(event.target.value)}/>
    <p className="field-help">{info.keyHelp} Keys are saved in Windows Credential Manager, never in your workspace file.</p>
    <div className="row-buttons">
      <button className="primary-button" disabled={disabled || !key.trim()}><KeyRound size={15}/> {disabled ? `Checking with ${info.name}…` : 'Verify and add'}</button>
      <button type="button" className="text-button" disabled={disabled} onClick={() => void run(() => openProviderKeys(provider))}>Get a {info.name} API key <AppWindow size={14}/></button>
      {onCancel && <button type="button" className="ghost-button" disabled={disabled} onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}

/** Video sources: named provider connections, each with its own API key. Used in Settings and on its own page. */
export default function VideoSources() {
  const [sources, setSources] = useState<VideoSource[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { listVideoSources().then(setSources).catch(() => setAvailable(false)); }, []);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (reason) { setError(errorText(reason, 'The request failed. Please try again.')); } finally { setBusy(false); }
  }
  if (!available) return <div className="status-line off"><span className="dot"/><span>Open the desktop app to manage video sources.</span></div>;
  if (sources === null) return <div className="status-line off"><span className="dot"/><span>Loading video sources…</span></div>;
  const replace = (next: VideoSource) => setSources(sources.map((item) => item.id === next.id ? next : item));
  const showForm = adding || sources.length === 0;
  return <div className="video-sources">
    {error && <div className="error-message" role="alert">{error}</div>}
    {message && <p className="success-message" role="status">{message}</p>}
    {sources.length > 0 && <div className="source-grid">{sources.map((source) => <SourceCard key={source.id} source={source} disabled={busy} run={run} onChange={replace} onRemoved={() => { setSources(sources.filter((item) => item.id !== source.id)); setMessage(`Removed ${source.name}.`); }}/>)}</div>}
    {showForm ? <AddSourceForm sources={sources} disabled={busy} run={run} onCancel={sources.length ? () => setAdding(false) : undefined} onAdded={(source) => { setSources([...sources, source]); setAdding(false); setMessage(`${source.name} is verified and ready to use.`); }}/>
      : <button className="outline-button add-source-button" disabled={busy} onClick={() => { setAdding(true); setMessage(''); }}><Plus size={15}/> Add video source</button>}
  </div>;
}
