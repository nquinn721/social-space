import { useState, type FormEvent } from 'react';
import { AppWindow, Check, Film, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { getPlatform, PLATFORMS, type Platform, type PlatformAction, type Video, type VideoCategory, type Workspace } from './model';
import { chooseVideoFile } from './queueService';
import { BrandMark, errorText, PageHeader } from './ui';
import './library.css';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
  onSave: (next: Workspace, message: string) => Promise<boolean | undefined>;
  onOpen: (platform: Platform, action: PlatformAction) => void;
};
const ORDER = PLATFORMS.map((platform) => platform.id);

/** The socials a brand posts to: every social it has a profile on, in platform order. */
export function brandSocials(workspace: Workspace, brandId: string): Platform[] {
  return ORDER.filter((platform) => workspace.accounts.some((account) => account.brandId === brandId && account.platform === platform));
}
/** How far a category is: videos, and how many are up on every social of the brand. */
export function categoryProgress(videos: Video[], socials: Platform[]) {
  const everywhere = videos.filter((video) => socials.length > 0 && socials.every((platform) => video.posted.includes(platform))).length;
  return { total: videos.length, everywhere };
}

/** Videos grouped by brand and category, with where each one is posted. */
export default function VideoLibrary({ workspace, loaded, busy, onSave, onOpen }: Props) {
  const brands = workspace.brands;
  const categories = workspace.categories ?? [];
  const videos = workspace.videos ?? [];
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const brand = brands.find((item) => item.id === brandId) ?? brands[0];
  const brandCategories = categories.filter((category) => category.brandId === brand?.id);
  const [categoryId, setCategoryId] = useState('');
  const category = brandCategories.find((item) => item.id === categoryId) ?? brandCategories[0];
  const [newCategory, setNewCategory] = useState('');
  const [title, setTitle] = useState('');
  const [mediaSource, setMediaSource] = useState('');
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');
  const socials = brand ? brandSocials(workspace, brand.id) : [];
  const shown = videos.filter((video) => video.categoryId === category?.id).sort((a, b) => b.createdAt - a.createdAt);
  const disabled = !loaded || busy;

  const save = (next: Partial<Workspace>, message: string) => onSave({ ...workspace, ...next }, message);
  function addCategory(event: FormEvent) {
    event.preventDefault();
    const name = newCategory.trim();
    if (!brand || !name || disabled) return;
    if (brandCategories.some((item) => item.name.toLowerCase() === name.toLowerCase())) { setError(`${brand.name} already has a ${name} category.`); return; }
    const made: VideoCategory = { id: crypto.randomUUID(), brandId: brand.id, name };
    setError('');
    void save({ categories: [...categories, made] }, `Added the ${name} category.`).then((ok) => { if (ok) { setNewCategory(''); setCategoryId(made.id); } });
  }
  function addVideo(event: FormEvent) {
    event.preventDefault();
    if (!brand || !category || !title.trim() || disabled) return;
    const video: Video = { id: crypto.randomUUID(), brandId: brand.id, categoryId: category.id, title: title.trim(), mediaSource: mediaSource.trim(), caption: caption.trim(), posted: [], createdAt: Date.now() };
    void save({ videos: [...videos, video] }, `Added "${video.title}" to ${category.name}.`).then((ok) => { if (ok) { setTitle(''); setMediaSource(''); setCaption(''); } });
  }
  function togglePosted(video: Video, platform: Platform) {
    if (disabled) return;
    const posted = video.posted.includes(platform) ? video.posted.filter((item) => item !== platform) : [...video.posted, platform];
    void save({ videos: videos.map((item) => item.id === video.id ? { ...item, posted } : item) }, posted.includes(platform) ? `Marked "${video.title}" as posted on ${getPlatform(platform).name}.` : `Marked "${video.title}" as not posted on ${getPlatform(platform).name}.`);
  }
  function removeVideo(video: Video) {
    if (disabled || !window.confirm(`Remove "${video.title}" from ${category?.name}? This does not delete it from any social.`)) return;
    void save({ videos: videos.filter((item) => item.id !== video.id) }, `Removed "${video.title}".`);
  }
  async function pickFile() {
    try { const path = await chooseVideoFile(); if (path) { setMediaSource(path); if (!title.trim()) setTitle(path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? ''); } }
    catch (reason) { setError(errorText(reason)); }
  }

  const header = <PageHeader eyebrow="Your videos, by brand and category" title="Video library" description="Group a brand's videos into categories like Rabbit. Every video goes to all of the brand's socials, and you can see where each one is posted."/>;
  if (!brand) return <>{header}<section className="card empty-state"><div className="empty-icon"><Film size={22}/></div><strong>No brands yet</strong><p>Create accounts for a brand first. Its categories and videos show up here.</p></section></>;

  return <>
    {header}
    {brands.length > 1 && <div className="segmented library-brands" role="group" aria-label="Brand">{brands.map((item) => <button type="button" key={item.id} aria-pressed={item.id === brand.id} onClick={() => { setBrandId(item.id); setCategoryId(''); setError(''); }}>{item.name}</button>)}</div>}
    <div className="library-layout">
      <aside className="card library-categories" aria-label="Categories">
        <h2>Categories</h2>
        {brandCategories.length === 0 && <p className="footnote">No categories yet. Add one, like Rabbit.</p>}
        <ul>{brandCategories.map((item) => {
          const progress = categoryProgress(videos.filter((video) => video.categoryId === item.id), socials);
          return <li key={item.id}><button type="button" className={item.id === category?.id ? 'selected' : ''} aria-pressed={item.id === category?.id} onClick={() => setCategoryId(item.id)}><strong>{item.name}</strong><small>{progress.total} {progress.total === 1 ? 'video' : 'videos'} · {progress.everywhere} on every social</small></button></li>;
        })}</ul>
        <form className="inline-add" onSubmit={addCategory}><label htmlFor="new-category" className="sr-only">New category</label><input id="new-category" maxLength={80} placeholder="New category" value={newCategory} onChange={(event) => setNewCategory(event.target.value)}/><button className="outline-button small-button" disabled={disabled || !newCategory.trim()}><Plus size={14}/> Add</button></form>
      </aside>
      <section className="library-main">
        {!category ? <div className="card empty-state"><strong>Pick or add a category</strong><p>Videos live inside a category of {brand.name}.</p></div> : <>
          <form className="card library-add" onSubmit={addVideo} aria-label={`Add a video to ${category.name}`}>
            <h2>Add a video to {category.name}</h2>
            <div className="field-row">
              <div><label htmlFor="video-title">Title</label><input id="video-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} required/></div>
              <div><label htmlFor="video-file">Video file <span>optional</span></label><div className="media-picker"><input id="video-file" value={mediaSource} maxLength={1000} onChange={(event) => setMediaSource(event.target.value)} placeholder="Choose a file"/><button type="button" className="outline-button" disabled={disabled} onClick={() => void pickFile()}><FolderOpen size={15}/> Choose</button></div></div>
            </div>
            <label htmlFor="video-caption">Caption <span>optional</span></label><textarea id="video-caption" rows={2} maxLength={2200} value={caption} onChange={(event) => setCaption(event.target.value)}/>
            <button className="primary-button" disabled={disabled || !title.trim()}><Plus size={15}/> Add video</button>
          </form>
          {socials.length === 0 && <p className="footnote">{brand.name} has no social profiles yet, so there is nowhere to post. Add them under Accounts.</p>}
          <div className="library-videos">
            {shown.length === 0 && <p className="footnote">No videos in {category.name} yet.</p>}
            {shown.map((video) => {
              const next = socials.find((platform) => !video.posted.includes(platform));
              return <article key={video.id} className="card library-video" aria-label={video.title}>
                <div className="library-video-head"><Film size={16}/><div><strong>{video.title}</strong><small>{video.posted.filter((platform) => socials.includes(platform)).length} of {socials.length} socials</small></div>
                  {next && <button type="button" className="outline-button small-button" disabled={busy} onClick={() => onOpen(next, 'post')}><AppWindow size={14}/> Upload to {getPlatform(next).name}</button>}
                  <button type="button" className="icon-button" aria-label={`Remove ${video.title}`} disabled={disabled} onClick={() => removeVideo(video)}><Trash2 size={15}/></button></div>
                <div className="library-posted" role="group" aria-label="Posted on">{socials.map((platform) => {
                  const done = video.posted.includes(platform);
                  return <button type="button" key={platform} className={`posted-chip ${done ? 'done' : ''}`} aria-pressed={done} disabled={disabled} onClick={() => togglePosted(video, platform)}><BrandMark platform={platform} small/>{getPlatform(platform).name}{done && <Check size={13}/>}</button>;
                })}</div>
              </article>;
            })}
          </div>
        </>}
        {error && <div className="error-message" role="alert">{error}</div>}
      </section>
    </div>
  </>;
}
