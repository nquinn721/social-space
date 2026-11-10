import { useEffect, useState, type FormEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { AlertCircle, AppWindow, Check, ChevronDown, ExternalLink, Film, FolderOpen, Loader2, Play, Plus, RotateCw, Sparkles, Trash2, X } from 'lucide-react';
import { getPlatform, PLATFORMS, type Platform, type PlatformAction, type Video, type VideoCategory, type Workspace } from './model';
import { chooseVideoFile } from './queueService';
import { BrandMark, errorText, PageHeader } from './ui';
import { ASPECT_RATIOS, PROVIDERS } from './videoProviders';
import { DESKTOP_ONLY, listVideoSources, type SourcesState } from './videoSourcesService';
import { useVideoGenerations } from './useVideoGenerations';
import { isLocalVideo, openVideoFile, showVideoInFolder, videoPreviewUrl } from './videoFileService';
import './library.css';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
  onSave: (next: Workspace, message: string) => Promise<boolean | undefined>;
  onOpen: (platform: Platform, action: PlatformAction) => void;
  onManageSources?: () => void;
};
type Panel = 'make' | 'add' | null;
const ORDER = PLATFORMS.map((platform) => platform.id);
/** Social videos are vertical, so new AI videos default to portrait. */
const DEFAULT_RATIO = '9:16';

/** The socials a brand posts to: every social it has a profile on, in platform order. */
export function brandSocials(workspace: Workspace, brandId: string): Platform[] {
  return ORDER.filter((platform) => workspace.accounts.some((account) => account.brandId === brandId && account.platform === platform));
}
/** How far a category is: videos, and how many are up on every social of the brand. */
export function categoryProgress(videos: Video[], socials: Platform[]) {
  const everywhere = videos.filter((video) => socials.length > 0 && socials.every((platform) => video.posted.includes(platform))).length;
  return { total: videos.length, everywhere };
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Videos grouped by brand and category, with where each one is posted. Videos can be added from a file or made with an AI video source. */
export default function VideoLibrary({ workspace, loaded, busy, onSave, onOpen, onManageSources }: Props) {
  const brands = workspace.brands;
  const categories = workspace.categories ?? [];
  const videos = workspace.videos ?? [];
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const brand = brands.find((item) => item.id === brandId) ?? brands[0];
  const brandCategories = categories.filter((category) => category.brandId === brand?.id);
  const [categoryId, setCategoryId] = useState('');
  const category = brandCategories.find((item) => item.id === categoryId) ?? brandCategories[0];
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState('');
  const generations = useVideoGenerations(workspace, onSave);
  const socials = brand ? brandSocials(workspace, brand.id) : [];
  const shown = videos.filter((video) => video.categoryId === category?.id).sort((a, b) => b.createdAt - a.createdAt);
  const disabled = !loaded || busy;

  const save = (next: Partial<Workspace>, message: string) => onSave({ ...workspace, ...next }, message);
  function pickCategory(id: string) { setCategoryId(id); setPanel(null); setError(''); }
  function addCategory(event: FormEvent) {
    event.preventDefault();
    const name = newCategory.trim();
    if (!brand || !name || disabled) return;
    if (brandCategories.some((item) => item.name.toLowerCase() === name.toLowerCase())) { setError(`${brand.name} already has a ${name} category.`); return; }
    const made: VideoCategory = { id: crypto.randomUUID(), brandId: brand.id, name };
    setError('');
    void save({ categories: [...categories, made] }, `Added the ${name} category.`).then((ok) => { if (ok) { setNewCategory(''); setAddingCategory(false); pickCategory(made.id); } });
  }
  function togglePosted(video: Video, platform: Platform) {
    if (disabled) return;
    const posted = video.posted.includes(platform) ? video.posted.filter((item) => item !== platform) : [...video.posted, platform];
    void save({ videos: videos.map((item) => item.id === video.id ? { ...item, posted } : item) }, posted.includes(platform) ? `Marked "${video.title}" as posted on ${getPlatform(platform).name}.` : `Marked "${video.title}" as not posted on ${getPlatform(platform).name}.`);
  }
  function removeVideo(video: Video) {
    const note = video.generation?.status === 'working' ? ' The source may still finish it, but it will not be saved here.' : ' This does not delete it from any social or from your PC.';
    if (disabled || !window.confirm(`Remove "${video.title}" from ${category?.name}?${note}`)) return;
    void save({ videos: videos.filter((item) => item.id !== video.id) }, `Removed "${video.title}".`);
  }

  const header = <PageHeader title="Video library" description="Each brand's videos, grouped into categories. Add a file or make one with AI, then track where it's posted."/>;
  if (!brand) return <>{header}<section className="card empty-state"><div className="empty-icon"><Film size={22}/></div><strong>No brands yet</strong><p>Create accounts for a brand first. Its categories and videos show up here.</p></section></>;
  const progress = categoryProgress(shown, socials);

  return <>
    {header}
    {brands.length > 1 && <div className="segmented library-brands" role="group" aria-label="Brand">{brands.map((item) => <button type="button" key={item.id} aria-pressed={item.id === brand.id} onClick={() => { setBrandId(item.id); pickCategory(''); }}>{item.name}</button>)}</div>}
    <div className="library-layout">
      <nav className="library-categories" aria-label="Categories">
        <div className="library-categories-head"><span>Categories</span>
          <button type="button" className="icon-button" aria-label="New category" aria-expanded={addingCategory} onClick={() => setAddingCategory((open) => !open)}>{addingCategory ? <X size={15}/> : <Plus size={15}/>}</button>
        </div>
        {addingCategory && <form className="inline-add" onSubmit={addCategory}>
          <label htmlFor="new-category" className="sr-only">Category name</label>
          <input id="new-category" autoFocus maxLength={80} placeholder="Category name" value={newCategory} onChange={(event) => setNewCategory(event.target.value)}/>
          <button className="outline-button small-button" disabled={disabled || !newCategory.trim()}>Add</button>
        </form>}
        {brandCategories.length === 0 && !addingCategory && <p className="library-hint">No categories yet.</p>}
        <ul>{brandCategories.map((item) => {
          const count = videos.filter((video) => video.categoryId === item.id).length;
          return <li key={item.id}><button type="button" className={item.id === category?.id ? 'selected' : ''} aria-pressed={item.id === category?.id} onClick={() => pickCategory(item.id)}><span>{item.name}</span><small>{count}</small></button></li>;
        })}</ul>
      </nav>
      <section className="library-main">
        {!category ? <div className="card empty-state"><div className="empty-icon"><Film size={22}/></div><strong>Add a category to start</strong><p>Videos live in a category of {brand.name}, like Rabbit.</p><button className="primary-button" onClick={() => setAddingCategory(true)}><Plus size={15}/> New category</button></div> : <>
          <div className="library-head">
            <div><h2>{category.name}</h2><p>{plural(progress.total, 'video')}{socials.length > 0 && ` · ${progress.everywhere} on every social`}</p></div>
            <div className="library-actions">
              <button type="button" className={panel === 'make' ? 'outline-button' : 'primary-button'} aria-expanded={panel === 'make'} onClick={() => setPanel(panel === 'make' ? null : 'make')}><Sparkles size={15}/> Make a video</button>
              <button type="button" className="outline-button" aria-expanded={panel === 'add'} onClick={() => setPanel(panel === 'add' ? null : 'add')}><Plus size={15}/> Add a file</button>
            </div>
          </div>
          {panel === 'make' && <MakeVideo key={category.id} brandName={brand.name} category={category} disabled={disabled} onMake={generations.make} onClose={() => setPanel(null)} onManageSources={onManageSources}/>}
          {panel === 'add' && <AddVideo key={category.id} brandId={brand.id} category={category} disabled={disabled} onSave={(video) => save({ videos: [...videos, video] }, `Added "${video.title}" to ${category.name}.`)} onClose={() => setPanel(null)}/>}
          {socials.length === 0 && <p className="library-hint">{brand.name} has no social profiles yet, so there is nowhere to post. Add them under Accounts.</p>}
          {shown.length === 0 ? <div className="library-empty">No videos in {category.name} yet. Make one with AI or add a file.</div> : <ul className="library-videos">
            {shown.map((video) => <VideoRow key={video.id} video={video} socials={socials} busy={busy} disabled={disabled} progress={generations.progress[video.id]}
              onToggle={(platform) => togglePosted(video, platform)} onOpen={onOpen} onRemove={() => removeVideo(video)} onRetry={() => generations.retry(video)}/>)}
          </ul>}
        </>}
        {error && <div className="error-message" role="alert">{error}</div>}
      </section>
    </div>
  </>;
}

type RowProps = { video: Video; socials: Platform[]; busy: boolean; disabled: boolean; progress?: string; onToggle: (platform: Platform) => void; onOpen: Props['onOpen']; onRemove: () => void; onRetry: () => void };
function VideoRow({ video, socials, busy, disabled, progress, onToggle, onOpen, onRemove, onRetry }: RowProps) {
  const job = video.generation;
  const next = socials.find((platform) => !video.posted.includes(platform));
  const fileName = video.mediaSource.split(/[\\/]/).pop();
  const playable = !job && isLocalVideo(video.mediaSource);
  const [watching, setWatching] = useState(false);
  return <li className={`library-video ${job ? `is-${job.status}` : ''}`} aria-label={video.title}>
    {playable ? <button type="button" className="library-video-icon library-play" aria-label={`${watching ? 'Hide' : 'Play'} ${video.title}`} aria-expanded={watching} onClick={() => setWatching(!watching)}>{watching ? <X size={16}/> : <Play size={16}/>}</button>
      : <div className="library-video-icon">{job?.status === 'working' ? <Loader2 size={16} className="spin"/> : job?.status === 'failed' ? <AlertCircle size={16}/> : <Film size={16}/>}</div>}
    <div className="library-video-body">
      {playable ? <button type="button" className="library-video-title" onClick={() => setWatching(!watching)}>{video.title}</button> : <strong>{video.title}</strong>}
      {job?.status === 'working' && <small>Being made by {job.sourceName} ({PROVIDERS[job.provider]?.name ?? job.provider}){progress ? ` · ${progress}` : ''}. Saves here when ready.</small>}
      {job?.status === 'failed' && <small className="library-failed">{job.message || `${job.sourceName} could not make this video.`}</small>}
      {!job && <small title={video.mediaSource}>{fileName || 'No file yet'}{socials.length > 0 && ` · ${video.posted.filter((platform) => socials.includes(platform)).length} of ${socials.length} socials`}</small>}
    </div>
    {!job && socials.length > 0 && <div className="library-posted" role="group" aria-label="Posted on">{socials.map((platform) => {
      const done = video.posted.includes(platform);
      return <button type="button" key={platform} className={`posted-chip ${done ? 'done' : ''}`} aria-pressed={done} aria-label={getPlatform(platform).name} title={done ? `Posted on ${getPlatform(platform).name}. Click to unmark.` : `Mark as posted on ${getPlatform(platform).name}`} disabled={disabled} onClick={() => onToggle(platform)}><BrandMark platform={platform} small/>{done && <Check size={12}/>}</button>;
    })}</div>}
    <div className="library-video-actions">
      {playable && <button type="button" className="ghost-button small-button" aria-expanded={watching} onClick={() => setWatching(!watching)}>{watching ? <><X size={14}/> Close</> : <><Play size={14}/> Watch</>}</button>}
      {!job && next && <button type="button" className="ghost-button small-button" disabled={busy} onClick={() => onOpen(next, 'post')}><AppWindow size={14}/> Upload to {getPlatform(next).name}</button>}
      {job && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={onRetry}><RotateCw size={14}/> {job.status === 'failed' ? 'Try again' : 'Check now'}</button>}
      <button type="button" className="icon-button" aria-label={`Remove ${video.title}`} disabled={disabled} onClick={onRemove}><Trash2 size={15}/></button>
    </div>
    {playable && watching && <VideoPlayer path={video.mediaSource} title={video.title}/>}
  </li>;
}

/** Plays a video saved on this PC right in the library. */
function VideoPlayer({ path, title }: { path: string; title: string }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    videoPreviewUrl(path).then((url) => { if (live) setSrc(url); }).catch((reason) => { if (live) setError(errorText(reason, 'Could not open this video.')); });
    return () => { live = false; };
  }, [path]);
  const act = (action: (file: string) => Promise<void>) => () => { setError(''); action(path).catch((reason) => setError(errorText(reason))); };
  return <div className="library-player">
    {src ? <video src={src} controls autoPlay aria-label={title} onError={() => setError('This video could not be played here. Try opening it in your player.')}/> : !error && <div className="library-player-loading"><Loader2 size={18} className="spin"/></div>}
    <div className="library-player-buttons">
      <button type="button" className="ghost-button small-button" onClick={act(openVideoFile)}><ExternalLink size={14}/> Open in player</button>
      <button type="button" className="ghost-button small-button" onClick={act(showVideoInFolder)}><FolderOpen size={14}/> Show in folder</button>
    </div>
    {error && <div className="error-message" role="alert">{error}</div>}
  </div>;
}

type AddProps = { brandId: string; category: VideoCategory; disabled: boolean; onSave: (video: Video) => Promise<boolean | undefined>; onClose: () => void };
function AddVideo({ brandId, category, disabled, onSave, onClose }: AddProps) {
  const [title, setTitle] = useState('');
  const [mediaSource, setMediaSource] = useState('');
  const [caption, setCaption] = useState('');
  const [showCaption, setShowCaption] = useState(false);
  const [error, setError] = useState('');
  async function pickFile() {
    try { const path = await chooseVideoFile(); if (path) { setMediaSource(path); if (!title.trim()) setTitle(path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? ''); } }
    catch (reason) { setError(errorText(reason)); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || disabled) return;
    const video: Video = { id: crypto.randomUUID(), brandId, categoryId: category.id, title: title.trim(), mediaSource: mediaSource.trim(), caption: caption.trim(), posted: [], createdAt: Date.now() };
    void onSave(video).then((ok) => { if (ok) onClose(); });
  }
  return <form className="card library-panel" onSubmit={submit} aria-label={`Add a video to ${category.name}`}>
    <div className="field-row">
      <div><label htmlFor="video-file">Video file</label><div className="media-picker"><input id="video-file" value={mediaSource} maxLength={1000} onChange={(event) => setMediaSource(event.target.value)} placeholder="Choose a file"/><button type="button" className="outline-button" disabled={disabled} onClick={() => void pickFile()}><FolderOpen size={15}/> Browse</button></div></div>
      <div><label htmlFor="video-title">Title</label><input id="video-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} required/></div>
    </div>
    {showCaption ? <><label htmlFor="video-caption">Caption</label><textarea id="video-caption" rows={2} maxLength={2200} value={caption} onChange={(event) => setCaption(event.target.value)}/></>
      : <button type="button" className="library-more" onClick={() => setShowCaption(true)}><ChevronDown size={14}/> Add a caption</button>}
    {error && <div className="error-message" role="alert">{error}</div>}
    <div className="library-panel-buttons"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={disabled || !title.trim()}>Add video</button></div>
  </form>;
}

type MakeProps = { brandName: string; category: VideoCategory; disabled: boolean; onMake: ReturnType<typeof useVideoGenerations>['make']; onClose: () => void; onManageSources?: () => void };
function MakeVideo({ brandName, category, disabled, onMake, onClose, onManageSources }: MakeProps) {
  const [state, setState] = useState<SourcesState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_RATIO);
  const [duration, setDuration] = useState<number | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { listVideoSources().then(setState).catch((reason) => setLoadError(isTauri() ? errorText(reason, 'Could not load video sources.') : DESKTOP_ONLY)); }, []);

  const usable = state?.sources.filter((source) => source.status !== 'rejected') ?? [];
  const source = usable.find((item) => item.id === sourceId) ?? usable.find((item) => item.id === state?.active) ?? usable[0];
  const provider = source ? PROVIDERS[source.provider] : null;
  const seconds = provider && duration !== null && provider.durations.includes(duration) ? duration : provider?.defaultDuration ?? 5;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!source || !prompt.trim() || sending || disabled) return;
    setSending(true); setError('');
    try { if (await onMake({ category, brandName, prompt: prompt.trim(), title, sourceId: source.id, aspectRatio, duration: seconds })) onClose(); }
    catch (reason) { setError(errorText(reason, 'The video could not be started. Please try again.')); }
    finally { setSending(false); }
  }

  if (loadError) return <div className="card library-panel"><div className="error-message" role="alert">{loadError}</div></div>;
  if (!state) return <div className="card library-panel library-loading"><Loader2 size={16} className="spin"/> Loading video sources…</div>;
  if (!source || !provider) return <div className="card library-panel">
    <strong>Connect a video source first</strong>
    <p className="library-hint">Add a Kling or Grok API key under Video sources, then make videos here.</p>
    {onManageSources && <button type="button" className="primary-button" onClick={onManageSources}>Set up video sources</button>}
  </div>;
  return <form className={`card library-panel provider-${provider.id}`} onSubmit={(event) => void submit(event)} aria-label={`Make a video for ${category.name}`}>
    <label htmlFor="make-prompt">Describe the video</label>
    <textarea id="make-prompt" required autoFocus maxLength={2500} rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What happens in the video? Describe the scene, style and mood."/>
    <div className="library-make-row">
      <div><label htmlFor="make-source">Made with</label>
        <select id="make-source" value={source.id} onChange={(event) => setSourceId(event.target.value)}>{usable.map((item) => <option key={item.id} value={item.id}>{item.name} · {PROVIDERS[item.provider].name}</option>)}</select></div>
      <div><label htmlFor="make-duration">Length</label>
        <select id="make-duration" value={seconds} onChange={(event) => setDuration(Number(event.target.value))}>{provider.durations.map((value) => <option key={value} value={value}>{value} seconds</option>)}</select></div>
    </div>
    {showOptions ? <div className="library-make-row">
      <div><label htmlFor="make-title">Title <span>optional</span></label><input id="make-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="From the description"/></div>
      <div><label htmlFor="make-ratio">Shape</label><select id="make-ratio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{ASPECT_RATIOS.map((ratio) => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}</select></div>
    </div> : <button type="button" className="library-more" onClick={() => setShowOptions(true)}><ChevronDown size={14}/> Title and shape (portrait by default)</button>}
    <p className="library-hint">Uses {provider.model}, billed by {provider.name}. It takes a few minutes and is saved into {category.name} when ready.</p>
    {error && <div className="error-message" role="alert">{error}</div>}
    <div className="library-panel-buttons"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={disabled || sending || !prompt.trim()}>{sending ? <Loader2 size={15} className="spin"/> : <Sparkles size={15}/>} Make video</button></div>
  </form>;
}
