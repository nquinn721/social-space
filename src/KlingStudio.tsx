import { useEffect, useState, type FormEvent } from 'react';
import { AppWindow, KeyRound } from 'lucide-react';
import { generateKlingVideo, getKlingVideo, openKlingVideo, type KlingTask } from './klingService';
import { listVideoSources, type VideoSource } from './videoSourcesService';
import { PROVIDERS } from './videoProviders';
import { errorText } from './ui';
import './videoSources.css';

const TASK_KEY = 'social-manager-kling-task';
const SOURCE_KEY = 'social-manager-kling-source';
type SavedTask = KlingTask & { sourceId: string };

function loadTask(): SavedTask | null {
  try {
    const saved = JSON.parse(localStorage.getItem(TASK_KEY) ?? 'null');
    return saved && typeof saved.id === 'string' && typeof saved.sourceId === 'string' ? { status: 'saved', message: null, videoUrl: null, id: saved.id, sourceId: saved.sourceId } : null;
  } catch { return null; }
}

export default function KlingStudio({ openKling, onManageSources, busy }: { openKling: () => Promise<void>; onManageSources: () => void; busy: boolean }) {
  const [sources, setSources] = useState<VideoSource[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [sourceId, setSourceId] = useState('');
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [duration, setDuration] = useState(5);
  const [task, setTask] = useState<SavedTask | null>(loadTask);
  const [error, setError] = useState('');
  useEffect(() => {
    listVideoSources().then((all) => {
      const usable = all.filter((source) => source.provider === 'kling' && source.status !== 'rejected');
      setSources(usable);
      const remembered = localStorage.getItem(SOURCE_KEY);
      setSourceId(usable.find((source) => source.id === remembered)?.id ?? usable.find((source) => source.status === 'verified')?.id ?? usable[0]?.id ?? '');
    }).catch(() => setAvailable(false));
  }, []);
  async function run(action: () => Promise<void>) { if (loading || busy) return; setLoading(true); setError(''); try { await action(); } catch (reason) { setError(errorText(reason, 'The request failed. Please try again.')); } finally { setLoading(false); } }
  function choose(id: string) { setSourceId(id); localStorage.setItem(SOURCE_KEY, id); }
  function remember(next: SavedTask) { localStorage.setItem(TASK_KEY, JSON.stringify({ id: next.id, sourceId: next.sourceId })); setTask(next); }
  function generate(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !sourceId) return;
    void run(async () => remember({ ...(await generateKlingVideo(sourceId, prompt.trim(), aspectRatio, duration)), sourceId }));
  }
  const selected = sources?.find((source) => source.id === sourceId);
  const taskSource = task ? sources?.find((source) => source.id === task.sourceId) : undefined;
  const count = sources?.length ?? 0;
  return <>
    <section className="kling-card">
      <div className="kling-art"><img src={PROVIDERS.kling.logo} alt=""/></div>
      <div className="kling-content">
        <span className="tool-label">VIDEO CREATION</span><h2>Kling AI</h2>
        <p>Bring an idea to life with AI-generated video. Create here with one of your Kling video sources, or open Kling in an app window.</p>
        <div className="tool-status"><span/> {count ? `${count} Kling ${count === 1 ? 'source' : 'sources'}` : 'No Kling source yet'} <span className="separator">/</span> Website available</div>
        <button className="outline-button" disabled={busy || loading} onClick={() => void openKling()}>Open Kling AI <AppWindow size={15}/></button>
      </div>
    </section>
    {!available ? <div className="footnote">Open the desktop app to use the Kling API.</div> : sources === null ? null : !sources.length ? <section className="settings-card kling-setup">
      <h2>Connect a Kling video source</h2>
      <p>Add your Kling API key as a video source. It's verified with Kling and saved in Windows Credential Manager. You can add several, for example one per Kling account.</p>
      <button className="primary-button" onClick={onManageSources}><KeyRound size={15}/> Add a video source</button>
    </section> : <section className="settings-card kling-setup">
      <h2>Create a video</h2>
      {error && <div className="error-message" role="alert">{error}</div>}
      <p>Uses Kling 3.0 Turbo at 720p. Generation is billed by Kling and requires available API credits. This view keeps your most recent request.</p>
      <form onSubmit={generate}>
        <label htmlFor="kling-source">Video source</label>
        <div className="source-select-row">
          <select id="kling-source" value={sourceId} onChange={(event) => choose(event.target.value)}>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}{source.status === 'verified' ? '' : ' (not checked)'}</option>)}</select>
          <button type="button" className="ghost-button small-button" onClick={onManageSources}>Manage sources</button>
        </div>
        {selected?.detail && <p className="source-detail">{selected.detail}</p>}
        <label htmlFor="kling-prompt">Describe your video</label>
        <textarea id="kling-prompt" required maxLength={2500} rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the scene you want to create"/>
        <div className="kling-options">
          <div><label htmlFor="kling-ratio">Aspect ratio</label><select id="kling-ratio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option value="16:9">Landscape (16:9)</option><option value="9:16">Portrait (9:16)</option><option value="1:1">Square (1:1)</option></select></div>
          <div><label htmlFor="kling-duration">Duration</label><select id="kling-duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))}>{[5, 10].map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></div>
        </div>
        <button className="primary-button" disabled={loading || busy || !prompt.trim() || !sourceId}>Generate video with Kling</button>
      </form>
      {task && <div className="task-result">
        <strong>Video request: {task.status}</strong>
        {taskSource && <p className="field-help">From {taskSource.name}</p>}
        {task.message && <p>{task.message}</p>}
        {task.videoUrl && <><p>Your video is ready. Open the video and save it to your device. Kling links expire, so save it promptly. Only your most recent request is kept here.</p><button className="outline-button" disabled={loading || busy} onClick={() => void run(() => openKlingVideo(task.sourceId, task.id))}>Open video <AppWindow size={14}/></button></>}
        {!task.videoUrl && <button className="outline-button" disabled={loading || busy} onClick={() => void run(async () => remember({ ...(await getKlingVideo(task.sourceId, task.id)), sourceId: task.sourceId }))}>Check status</button>}
      </div>}
    </section>}
  </>;
}
