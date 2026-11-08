import { useEffect, useState, type FormEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { AppWindow, KeyRound } from 'lucide-react';
import { DESKTOP_ONLY, generateVideo, getVideo, listVideoSources, openProviderSite, openVideo, setActiveVideoSource, type SourcesState, type StartedVideo } from './videoSourcesService';
import { ASPECT_RATIOS, PROVIDERS } from './videoProviders';
import { errorText } from './ui';
import './videoSources.css';

const TASK_KEY = 'social-manager-video-task';
type SavedTask = Pick<StartedVideo, 'id' | 'sourceId' | 'sourceName' | 'provider'> & Partial<StartedVideo>;

function loadTask(): SavedTask | null {
  try {
    const saved = JSON.parse(localStorage.getItem(TASK_KEY) ?? 'null');
    return saved && typeof saved.id === 'string' && typeof saved.sourceId === 'string' && saved.provider in PROVIDERS ? { id: saved.id, sourceId: saved.sourceId, sourceName: String(saved.sourceName ?? ''), provider: saved.provider, status: 'saved' } : null;
  } catch { return null; }
}

/** Creates videos with the active video source, which can be switched here or under Video sources. */
export default function VideoStudio({ onManageSources }: { onManageSources: () => void }) {
  const [state, setState] = useState<SourcesState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [duration, setDuration] = useState<number | null>(null);
  const [task, setTask] = useState<SavedTask | null>(loadTask);
  const [error, setError] = useState('');
  useEffect(() => { listVideoSources().then(setState).catch((reason) => setLoadError(isTauri() ? errorText(reason, 'Could not load video sources.') : DESKTOP_ONLY)); }, []);
  async function run(action: () => Promise<void>) { if (loading) return; setLoading(true); setError(''); try { await action(); } catch (reason) { setError(errorText(reason, 'The request failed. Please try again.')); } finally { setLoading(false); } }
  function remember(next: SavedTask) { localStorage.setItem(TASK_KEY, JSON.stringify({ id: next.id, sourceId: next.sourceId, sourceName: next.sourceName, provider: next.provider })); setTask(next); }

  const usable = state?.sources.filter((source) => source.status !== 'rejected') ?? [];
  const active = state?.sources.find((source) => source.id === state.active);
  const provider = PROVIDERS[active?.provider ?? 'kling'];
  const seconds = duration !== null && provider.durations.includes(duration) ? duration : provider.defaultDuration;
  function generate(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !active) return;
    void run(async () => remember(await generateVideo(active.id, prompt.trim(), aspectRatio, seconds)));
  }
  const taskInfo = task ? PROVIDERS[task.provider] : null;
  return <>
    <section className={`kling-card studio-card provider-${provider.id}`}>
      <div className="kling-art"><img src={provider.logo} alt=""/></div>
      <div className="kling-content">
        <span className="tool-label">VIDEO CREATION</span><h2>{active ? provider.name : 'AI video'}</h2>
        <p>{active ? <>Videos are created with <strong>{active.name}</strong>. Switch the source any time and every new video uses it.</> : 'Connect Kling, Grok or another provider under Video sources, then create videos here.'}</p>
        {active && <button className="outline-button" disabled={loading} onClick={() => void run(() => openProviderSite(provider.id))}>Open {provider.name} <AppWindow size={15}/></button>}
      </div>
    </section>
    {loadError ? <div className="status-line off" role="alert"><span className="dot"/><span>{loadError}</span></div> : state === null ? null : !active ? <section className="settings-card kling-setup">
      <h2>Connect a video source</h2>
      <p>Add an API key for Kling or Grok as a video source. It's verified with the provider and saved in Windows Credential Manager.</p>
      <button className="primary-button" onClick={onManageSources}><KeyRound size={15}/> Add a video source</button>
    </section> : <section className="settings-card kling-setup">
      <h2>Create a video</h2>
      {error && <div className="error-message" role="alert">{error}</div>}
      <p>Uses {provider.model}. Generation is billed by {provider.name} to the source's account. This view keeps your most recent request.</p>
      <form onSubmit={generate}>
        <label htmlFor="studio-source">Video source</label>
        <div className="source-select-row">
          <select id="studio-source" value={active.id} disabled={loading} onChange={(event) => { const id = event.target.value; void run(async () => setState(await setActiveVideoSource(id))); }}>
            {usable.map((source) => <option key={source.id} value={source.id}>{source.name} · {PROVIDERS[source.provider].name}{source.status === 'verified' ? '' : ' (not checked)'}</option>)}
          </select>
          <button type="button" className="ghost-button small-button" onClick={onManageSources}>Manage sources</button>
        </div>
        {active.detail && <p className="source-detail">{active.detail}</p>}
        <label htmlFor="studio-prompt">Describe your video</label>
        <textarea id="studio-prompt" required maxLength={2500} rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the scene you want to create"/>
        <div className="kling-options">
          <div><label htmlFor="studio-ratio">Aspect ratio</label><select id="studio-ratio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{ASPECT_RATIOS.map((ratio) => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}</select></div>
          <div><label htmlFor="studio-duration">Duration</label><select id="studio-duration" value={seconds} onChange={(event) => setDuration(Number(event.target.value))}>{provider.durations.map((value) => <option key={value} value={value}>{value} seconds</option>)}</select></div>
        </div>
        <button className="primary-button" disabled={loading || !prompt.trim()}>Generate with {active.name}</button>
      </form>
      {task && taskInfo && <div className="task-result">
        <strong>Video request: {task.status}</strong>
        <p className="field-help">From {task.sourceName || 'a video source'} ({taskInfo.name})</p>
        {task.message && <p>{task.message}</p>}
        {task.videoUrl && <><p>Your video is ready. Open it and save it to your device. Provider links expire, so save it promptly. Only your most recent request is kept here.</p><button className="outline-button" disabled={loading} onClick={() => void run(() => openVideo(task.sourceId, task.id))}>Open video <AppWindow size={14}/></button></>}
        {!task.videoUrl && <button className="outline-button" disabled={loading} onClick={() => void run(async () => remember({ ...task, ...(await getVideo(task.sourceId, task.id)) }))}>Check status</button>}
      </div>}
    </section>}
  </>;
}
