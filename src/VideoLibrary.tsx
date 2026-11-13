import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { AlertCircle, AppWindow, Check, ChevronDown, ExternalLink, Film, FolderOpen, Link2, Loader2, Pencil, Play, Plus, RotateCw, Send, Sparkles, Trash2, X } from 'lucide-react';
import { getPlatform, PLATFORMS, type Platform, type PlatformAction, type PostDetails, type Video, type VideoCategory, type Workspace } from './model';
import { chooseVideoFile } from './queueService';
import { BrandMark, errorText, PageHeader } from './ui';
import { ASPECT_RATIOS, PROVIDERS } from './videoProviders';
import { DESKTOP_ONLY, listVideoSources, type SourcesState } from './videoSourcesService';
import { useVideoGenerations } from './useVideoGenerations';
import { publishVideoToInstagram, useBrandInstagram, type BrandInstagram } from './useBrandInstagram';
import { isLocalVideo, openVideoFile, showVideoInFolder, videoPreviewUrl } from './videoFileService';
import { detailProblems, detailsOf, formatMs, newPost, hashtagText, LIMITS, parseHashtags, postText, startingPost, STAGES, videoStage, YOUTUBE_TITLE_LIMIT, type Stage } from './postDetails';
import { suggestPost } from './assistant/postSuggest';
import { useConfirm } from './ConfirmDialog';
import { openInstagramPost } from './instagramService';
import PartnerReviewControls from './PartnerReviewControls';
import { useBrowserPosting } from './useBrowserPosting';
import { API_UPLOADS, postModeNote } from './postingMode';
import { testModeOf, withPosted } from './appReviews';
import './library.css';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
  onSave: (next: Workspace, message: string) => Promise<boolean | undefined>;
  onOpen: (platform: Platform, action: PlatformAction) => void;
  onManageSources?: () => void;
  /** Shows only this brand's content, inside its brand page (no page header or brand switcher). */
  brandId?: string;
  /** Goes to where the brand's Instagram profile is connected for posting. */
  onConnectInstagram?: () => void;
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

/**
 * A brand's videos, grouped into categories, moving from Making to Review to Ready to Posted.
 * Videos can be added from a file or made with an AI video source; each has its own post details.
 */
export default function VideoLibrary({ workspace, loaded, busy, onSave, onOpen, onManageSources, brandId: fixedBrand, onConnectInstagram }: Props) {
  const brands = workspace.brands;
  const categories = workspace.categories ?? [];
  const videos = workspace.videos ?? [];
  const [brandId, setBrandId] = useState(fixedBrand ?? brands[0]?.id ?? '');
  const brand = brands.find((item) => item.id === (fixedBrand ?? brandId)) ?? (fixedBrand ? undefined : brands[0]);
  const instagram = useBrandInstagram(workspace, brand?.id);
  const brandCategories = categories.filter((category) => category.brandId === brand?.id);
  const [categoryId, setCategoryId] = useState('');
  const category = brandCategories.find((item) => item.id === categoryId) ?? brandCategories[0];
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [stage, setStage] = useState<Stage | 'all'>('all');
  const [error, setError] = useState('');
  const generations = useVideoGenerations(workspace, onSave);
  const browser = useBrowserPosting(workspace, onSave);
  const socials = brand ? brandSocials(workspace, brand.id) : [];
  const inCategory = videos.filter((video) => video.categoryId === category?.id).sort((a, b) => b.createdAt - a.createdAt);
  const shown = stage === 'all' ? inCategory : inCategory.filter((video) => videoStage(video, socials) === stage);
  const disabled = !loaded || busy;

  const save = (next: Partial<Workspace>, message: string) => onSave({ ...workspace, ...next }, message);
  useAutoFill(workspace, brand?.id, onSave);
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
    const test = testModeOf(workspace.setup, platform);
    void save({ videos: videos.map((item) => item.id === video.id ? withPosted(item, posted, workspace.setup) : item) }, posted.includes(platform) ? `Marked "${video.title}" as posted on ${getPlatform(platform).name}${test ? ` (test: ${test.test?.mode})` : ''}.` : `Marked "${video.title}" as not posted on ${getPlatform(platform).name}.`);
  }
  /** Saves a video's post details, and its category's defaults when asked. posted replaces where it is up. */
  function savePost(draft: Video, saveDefaults: boolean, message: string, posted?: Platform[]) {
    const latest = workspace.videos ?? [];
    const nextCategories = saveDefaults ? categories.map((item) => item.id === draft.categoryId ? { ...item, defaults: { caption: draft.caption, hashtags: draft.details?.hashtags ?? [] } } : item) : categories;
    return save({ videos: latest.map((item) => item.id === draft.id ? withPosted({ ...draft, posted: item.posted, testPosts: item.testPosts }, posted ?? item.posted, workspace.setup) : item), categories: nextCategories }, message);
  }
  /** Posts the video as a Reel on the brand's connected Instagram profile, then saves its details and marks it posted there. */
  async function post(draft: Video, saveDefaults: boolean) {
    if (!instagram) return;
    let link: string | undefined;
    try { link = (await publishVideoToInstagram(instagram, draft)).permalink; }
    catch (reason) {
      // Keep edits made in the Post panel even when Instagram refuses the video.
      const saved = (workspace.videos ?? []).find((item) => item.id === draft.id);
      if (saveDefaults || JSON.stringify(saved) !== JSON.stringify(draft)) await savePost(draft, saveDefaults, `Saved the post details of "${draft.title}".`);
      throw reason;
    }
    const posted = link ? { ...draft, links: { ...draft.links, instagram: link } } : draft;
    await savePost(posted, saveDefaults, `Posted "${draft.title}" to @${instagram.username} on Instagram.`, draft.posted.includes('instagram') ? draft.posted : [...draft.posted, 'instagram']);
  }
  function removeVideo(video: Video) {
    const note = video.generation?.status === 'working' ? ' The source may still finish it, but it will not be saved here.' : ' This does not delete it from any social or from your PC.';
    if (disabled || !window.confirm(`Remove "${video.title}" from ${category?.name}?${note}`)) return;
    void save({ videos: videos.filter((item) => item.id !== video.id) }, `Removed "${video.title}".`);
  }

  const header = fixedBrand ? null : <PageHeader title="Video library" description="Each brand's videos, grouped into categories. Add a file or make one with AI, then post it to the brand's socials."/>;
  if (!brand) return <>{header}<section className="card empty-state"><div className="empty-icon"><Film size={22}/></div><strong>No brands yet</strong><p>Create accounts for a brand first. Its categories and videos show up here.</p></section></>;
  const progress = categoryProgress(inCategory, socials);
  const counts = Object.fromEntries(STAGES.map(({ id }) => [id, inCategory.filter((video) => videoStage(video, socials) === id).length])) as Record<Stage, number>;

  return <>
    {header}
    {!fixedBrand && brands.length > 1 && <div className="segmented library-brands" role="group" aria-label="Brand">{brands.map((item) => <button type="button" key={item.id} aria-pressed={item.id === brand.id} onClick={() => { setBrandId(item.id); pickCategory(''); }}>{item.name}</button>)}</div>}
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
        {!category ? <div className="card empty-state"><div className="empty-icon"><Film size={22}/></div><strong>Add a category to start</strong><p>Videos live in a category of {brand.name}, like Rabbit. Each video goes to every social of the brand.</p><button className="primary-button" onClick={() => setAddingCategory(true)}><Plus size={15}/> New category</button></div> : <>
          <div className="library-head">
            <div><h2>{category.name}</h2><p>{plural(progress.total, 'video')}{socials.length > 0 && ` · ${progress.everywhere} on every social`}</p></div>
            <div className="library-actions">
              <button type="button" className={panel === 'make' ? 'outline-button' : 'primary-button'} aria-expanded={panel === 'make'} onClick={() => setPanel(panel === 'make' ? null : 'make')}><Sparkles size={15}/> Make a video</button>
              <button type="button" className="outline-button" aria-expanded={panel === 'add'} onClick={() => setPanel(panel === 'add' ? null : 'add')}><Plus size={15}/> Add a file</button>
            </div>
          </div>
          {panel === 'make' && <MakeVideo key={category.id} brandName={brand.name} category={category} disabled={disabled} onMake={generations.make} onClose={() => setPanel(null)} onManageSources={onManageSources}/>}
          {panel === 'add' && <AddVideo key={category.id} brandId={brand.id} category={category} disabled={disabled} onSave={(video) => save({ videos: [...videos, video] }, `Added "${video.title}" to ${category.name}.`)} onClose={() => setPanel(null)}/>}
          {socials.map((platform) => testModeOf(workspace.setup, platform)).filter((review) => review?.test).map((review) => <p key={review!.provider} className="test-mode-note" role="note"><span className="test-badge">Test</span>{review!.test!.limits} Posts made with the Post on {getPlatform(review!.provider === 'google' ? 'youtube' : 'tiktok').name} button go through its own page, so they are real, public posts.</p>)}
          {socials.length === 0 && <p className="library-hint">{brand.name} has no social profiles yet, so there is nowhere to post. Add them under Profiles.</p>}
          {inCategory.length > 0 && <div className="segmented library-stages" role="group" aria-label="Stage">
            <button type="button" aria-pressed={stage === 'all'} onClick={() => setStage('all')}>All <small>{inCategory.length}</small></button>
            {STAGES.map(({ id, label }) => <button type="button" key={id} aria-pressed={stage === id} onClick={() => setStage(id)}>{label} <small>{counts[id]}</small></button>)}
          </div>}
          {inCategory.length === 0 ? <div className="library-empty">No videos in {category.name} yet. Make one with AI or add a file.</div>
            : shown.length === 0 ? <div className="library-empty">Nothing in {STAGES.find((item) => item.id === stage)?.label} right now.</div> : <ul className="library-videos">
            {shown.map((video) => <VideoRow key={video.id} video={video} socials={socials} busy={busy} disabled={disabled} progress={generations.progress[video.id]}
              onToggle={(platform) => togglePosted(video, platform)} onOpen={onOpen} onRemove={() => removeVideo(video)} onRetry={() => generations.retry(video)}
              category={category} brandName={brand.name} onSavePost={(draft, defaults) => savePost(draft, defaults, `Saved the post details of "${draft.title}".`)}
              instagram={instagram} onPost={post} onConnectInstagram={onConnectInstagram} browser={browser} marks={workspace.setup}/>)}
          </ul>}
        </>}
        {error && <div className="error-message" role="alert">{error}</div>}
      </section>
    </div>
  </>;
}

/**
 * Every video is a post from the start: once a video of the brand has its file and no description yet,
 * the local assistant writes one with hashtags (one video at a time, once per video while the app is open).
 * If the assistant is not running, the post keeps its category's defaults.
 */
function useAutoFill(workspace: Workspace, brandId: string | undefined, onSave: Props['onSave']) {
  const latest = useRef(workspace);
  latest.current = workspace;
  const tried = useRef(new Set<string>());
  const running = useRef(false);
  const [tick, setTick] = useState(0);
  const next = (workspace.videos ?? []).find((video) => video.brandId === brandId && !video.generation && video.mediaSource && !video.caption.trim() && !tried.current.has(video.id));
  useEffect(() => {
    if (!next || running.current || !isTauri()) return;
    const video = next;
    tried.current.add(video.id);
    running.current = true;
    const current = latest.current;
    const brand = current.brands.find((item) => item.id === video.brandId)?.name ?? '';
    const category = current.categories?.find((item) => item.id === video.categoryId);
    const socials = brandSocials(current, video.brandId);
    const limit = Math.min(...(socials.length ? socials : ['instagram' as Platform]).map((platform) => LIMITS[platform].text));
    suggestPost({ brand, category: category?.name ?? '', title: video.title, prompt: video.prompt, socials: socials.map((platform) => getPlatform(platform).name), currentHashtags: detailsOf(video).hashtags, limit })
      .then((idea) => {
        const now = latest.current;
        const saved = (now.videos ?? []).find((item) => item.id === video.id);
        if (!saved || saved.caption.trim()) return;
        const details = detailsOf(saved);
        const filled = { ...saved, caption: idea.description, details: { ...details, hashtags: idea.hashtags.length ? idea.hashtags : details.hashtags } };
        return onSave({ ...now, videos: (now.videos ?? []).map((item) => item.id === video.id ? filled : item) }, `Wrote the post for "${video.title}". Check it and approve it to post.`);
      })
      .catch(() => { /* Assistant not running: the post keeps its category's defaults. */ })
      .finally(() => { running.current = false; setTick((value) => value + 1); });
  }, [next?.id, tick]);
}

/** Socials the app posts to itself; the others go through their own upload page in an app window. */
const API_SOCIALS: Platform[] = API_UPLOADS;
type BrowserPosting = ReturnType<typeof useBrowserPosting>;

type RowProps = { video: Video; category: VideoCategory; brandName: string; socials: Platform[]; busy: boolean; disabled: boolean; progress?: string; onToggle: (platform: Platform) => void; onOpen: Props['onOpen']; onRemove: () => void; onRetry: () => void;
  onSavePost?: (draft: Video, saveDefaults: boolean) => Promise<boolean | undefined>;
  instagram?: BrandInstagram | null; onPost?: (draft: Video, saveDefaults: boolean) => Promise<void>; onConnectInstagram?: () => void;
  browser?: BrowserPosting; marks?: Record<string, number> };
function VideoRow({ video, category, brandName, socials, busy, disabled, progress, onToggle, onOpen, onRemove, onRetry, onSavePost, instagram, onPost, onConnectInstagram, browser, marks }: RowProps) {
  const job = video.generation;
  const stage = videoStage(video, socials);
  const fileName = video.mediaSource.split(/[\\/]/).pop();
  const playable = !job && isLocalVideo(video.mediaSource);
  const [watching, setWatching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const automatic = canPostAutomatically(video, socials, instagram, !!onPost);
  const needsConnect = !job && socials.includes('instagram') && !video.posted.includes('instagram') && instagram?.connected === false && !!onConnectInstagram;
  const tags = detailsOf(video).hashtags;
  const { confirm, dialog } = useConfirm();
  const instagramLink = video.links?.instagram;
  const openPost = () => { if (instagramLink) openInstagramPost(instagramLink).catch((reason) => setError(errorText(reason))); };
  /** Approving posts it: straight to every social the app can post to, after one confirmation. */
  async function approve(draft: Video, saveDefaults: boolean) {
    if (!onPost || !instagram || working) return false;
    const problems = detailProblems(draft, socials);
    if (problems.length) { setEditing(true); setError(problems[0]); return false; }
    const caption = postText(draft);
    const ok = await confirm({
      title: `Post "${draft.title}" to Instagram?`,
      body: <><p>It goes live on <strong>@{instagram.username}</strong> right away.</p>{caption ? <p className="confirm-caption">{caption}</p> : <p className="post-empty">No caption.</p>}</>,
      confirmLabel: 'Post to Instagram',
    });
    if (!ok) return false;
    setWorking(true); setError('');
    try { await onPost(draft, saveDefaults); return true; }
    catch (reason) { setError(errorText(reason, 'Instagram did not publish this video.')); return false; }
    finally { setWorking(false); }
  }
  const pagePosts = browser && !job ? socials.filter((platform) => !API_SOCIALS.includes(platform) && !video.posted.includes(platform)) : [];
  /** Opens the social's upload page with this post filled in, after saving any edits. */
  async function postOnPage(draft: Video, platform: Platform, saveDefaults = false) {
    if (!browser || !onSavePost) return false;
    const problems = detailProblems(draft, socials);
    if (problems.length) { setEditing(true); setError(problems[0]); return false; }
    setError('');
    try {
      const saved = JSON.stringify({ caption: video.caption, details: video.details }) === JSON.stringify({ caption: draft.caption, details: draft.details });
      if ((!saved || saveDefaults) && !(await onSavePost(draft, saveDefaults))) return false;
      await browser.post(draft, platform);
      return true;
    } catch (reason) { setError(errorText(reason, `Could not open the ${getPlatform(platform).name} upload page.`)); return false; }
  }
  return <li className={`library-video post-card ${job ? `is-${job.status}` : ''}`} aria-label={video.title}>
    {playable ? <button type="button" className="library-video-icon library-play" aria-label={`${watching ? 'Hide' : 'Play'} ${video.title}`} aria-expanded={watching} onClick={() => setWatching(!watching)}>{watching ? <X size={16}/> : <Play size={16}/>}</button>
      : <div className="library-video-icon">{job?.status === 'working' ? <Loader2 size={16} className="spin"/> : job?.status === 'failed' ? <AlertCircle size={16}/> : <Film size={16}/>}</div>}
    <div className="library-video-body">
      <div className="library-video-titleline">{playable ? <button type="button" className="library-video-title" onClick={() => setWatching(!watching)}>{video.title}</button> : <strong>{video.title}</strong>}<span className={`stage-pill stage-${stage}`}>{STAGES.find((item) => item.id === stage)?.label}</span></div>
      {job?.status === 'working' && <small>Being made by {job.sourceName} ({PROVIDERS[job.provider]?.name ?? job.provider}){progress ? ` · ${progress}` : ''}. Saves here when ready.</small>}
      {job?.status === 'failed' && <small className="library-failed">{job.message || `${job.sourceName} could not make this video.`}</small>}
      {!job && <small title={video.mediaSource}>{fileName || 'No file yet'}{socials.length > 0 && ` · ${video.posted.filter((platform) => socials.includes(platform)).length} of ${socials.length} socials`}</small>}
    </div>
    {!job && socials.length > 0 && <div className="library-posted" role="group" aria-label="Posted on">{socials.map((platform) => {
      const done = video.posted.includes(platform);
      const live = done && platform === 'instagram' && instagramLink;
      if (live) return <button type="button" key={platform} className="posted-chip done" aria-label="View on Instagram" title="Posted on Instagram. Click to view the post." onClick={openPost}><BrandMark platform={platform} small/><Check size={12}/></button>;
      return <button type="button" key={platform} className={`posted-chip ${done ? 'done' : ''}`} aria-pressed={done} aria-label={getPlatform(platform).name} title={done ? `Posted on ${getPlatform(platform).name}. Click to unmark.` : `Mark as posted on ${getPlatform(platform).name}`} disabled={disabled} onClick={() => onToggle(platform)}><BrandMark platform={platform} small/>{done && <Check size={12}/>}{done && video.testPosts?.[platform] !== undefined && <span className="test-badge" title="Posted while this social's app was in test mode">Test</span>}</button>;
    })}</div>}
    <div className="library-video-actions">
      {playable && <button type="button" className="ghost-button small-button" aria-expanded={watching} onClick={() => setWatching(!watching)}>{watching ? <><X size={14}/> Close</> : <><Play size={14}/> Watch</>}</button>}
      {instagramLink && video.posted.includes('instagram') && <button type="button" className="ghost-button small-button" onClick={openPost}><ExternalLink size={14}/> View on Instagram</button>}
      {!job && onSavePost && <button type="button" className="ghost-button small-button" aria-expanded={editing} onClick={() => setEditing(!editing)}><Pencil size={14}/> Edit post</button>}
      {stage === 'review' && automatic && !editing && <button type="button" className="primary-button small-button" disabled={busy || working} onClick={() => void approve(video, false)}>{working ? <><Loader2 size={14} className="spin"/> Posting…</> : <><Send size={14}/> Approve and post</>}</button>}
      {stage === 'review' && !editing && pagePosts.map((platform) => <button type="button" key={platform} className="outline-button small-button" disabled={busy || working} title={`Opens ${getPlatform(platform).name}'s upload page with everything filled in. You press Post.`} onClick={() => void postOnPage(video, platform)}><BrandMark platform={platform} small/> {browser?.isOpen(video.id, platform) ? 'Open again' : `Post on ${getPlatform(platform).name}`}</button>)}
      {stage === 'review' && needsConnect && !editing && <button type="button" className="outline-button small-button" onClick={onConnectInstagram}><Link2 size={14}/> Connect Instagram to post</button>}
      {job && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={onRetry}><RotateCw size={14}/> {job.status === 'failed' ? 'Try again' : 'Check now'}</button>}
      <button type="button" className="icon-button" aria-label={`Remove ${video.title}`} disabled={disabled} onClick={onRemove}><Trash2 size={15}/></button>
    </div>
    {!job && !editing && <div className="post-preview" aria-label="Post">
      {video.caption.trim() ? <p>{video.caption.trim()}</p> : <p className="post-empty">No description yet. Edit the post or use Suggest with AI.</p>}
      {tags.length > 0 && <p className="post-tags">{hashtagText(tags)}</p>}
    </div>}
    {!editing && stage !== 'making' && <PartnerReviewControls video={video} socials={socials} disabled={disabled || working}/>}
    {working && !video.posted.includes('instagram') && <p className="library-hint" role="status">Uploading to Instagram. This can take a few minutes; keep the app open.</p>}
    {dialog}
    {browser && socials.filter((platform) => browser.isAsking(video.id, platform)).map((platform) => <div key={platform} className="post-ask" role="status">
      <BrandMark platform={platform} small/><span>Did "{video.title}" go up on {getPlatform(platform).name}?</span>
      <button type="button" className="primary-button small-button" disabled={disabled} onClick={() => void browser.confirm({ videoId: video.id, platform }, true)}><Check size={14}/> Yes, mark posted</button>
      <button type="button" className="ghost-button small-button" onClick={() => void browser.confirm({ videoId: video.id, platform }, false)}>Not yet</button>
    </div>)}
    {error && !editing && <div className="error-message" role="alert">{error}</div>}
    {editing && onSavePost && <PostPanel video={video} category={category} brandName={brandName} socials={socials} busy={busy || working} disabled={disabled} instagram={instagram} onOpen={onOpen}
      error={error} working={working} onSave={onSavePost} onApprove={onPost ? approve : undefined} onConnectInstagram={onConnectInstagram} onClose={() => { setEditing(false); setError(''); }}
      onPostOnPage={browser ? async (draft, platform, defaults) => { if (await postOnPage(draft, platform, defaults)) setEditing(false); } : undefined} marks={marks}/>}
    {playable && watching && <VideoPlayer path={video.mediaSource} title={video.title}/>}
  </li>;
}

/** Whether approving posts the video by itself: its Instagram post is still to do and the profile is connected through Meta. */
function canPostAutomatically(video: Video, socials: Platform[], instagram: BrandInstagram | null | undefined, canPost: boolean) {
  return !video.generation && canPost && socials.includes('instagram') && !video.posted.includes('instagram')
    && !!instagram?.connected && instagram.canUploadFiles && isLocalVideo(video.mediaSource);
}

type PanelProps = { video: Video; category: VideoCategory; brandName: string; socials: Platform[]; busy: boolean; disabled: boolean; instagram?: BrandInstagram | null; onOpen: Props['onOpen'];
  error: string; working: boolean; onSave: (draft: Video, saveDefaults: boolean) => Promise<boolean | undefined>; onApprove?: (draft: Video, saveDefaults: boolean) => Promise<boolean>; onConnectInstagram?: () => void; onClose: () => void;
  onPostOnPage?: (draft: Video, platform: Platform, saveDefaults: boolean) => Promise<void>; marks?: Record<string, number> };
/**
 * Posting in one step: everything that goes out with the video (description, hashtags, cover, YouTube
 * title, labels), starting from the category's saved defaults, then where it goes and Post.
 */
function PostPanel({ video, category, brandName, socials, busy, disabled, instagram, onOpen, error: postError, working, onSave, onApprove, onConnectInstagram, onClose, onPostOnPage, marks }: PanelProps) {
  const start = startingPost(video, category);
  const [caption, setCaption] = useState(start.caption);
  const [tags, setTags] = useState(hashtagText(start.details.hashtags));
  const [details, setDetails] = useState<PostDetails>(start.details);
  const [saveDefaults, setSaveDefaults] = useState(!category.defaults);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const set = (change: Partial<PostDetails>) => setDetails((current) => ({ ...current, ...change }));
  const draft: Video = { ...video, caption: caption.trim(), details: { ...details, hashtags: parseHashtags(tags) } };
  const problems = detailProblems(draft, socials);
  const text = postText(draft);
  const id = (name: string) => `${name}-${video.id}`;
  const waiting = socials.filter((platform) => !video.posted.includes(platform));
  const automatic = waiting.includes('instagram') && canPostAutomatically(video, socials, instagram, !!onApprove);
  const limit = Math.min(...(socials.length ? socials : ['instagram' as Platform]).map((platform) => LIMITS[platform].text));

  async function suggest() {
    if (suggesting) return;
    setSuggesting(true); setError('');
    try {
      const idea = await suggestPost({ brand: brandName, category: category.name, title: video.title, prompt: video.prompt, socials: socials.map((platform) => getPlatform(platform).name), currentHashtags: parseHashtags(tags), limit });
      if (idea.description) setCaption(idea.description);
      if (idea.hashtags.length) setTags(hashtagText(idea.hashtags));
    } catch (reason) { setError(errorText(reason, 'The assistant could not suggest anything. Check the assistant under Settings.')); }
    finally { setSuggesting(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { setError('Could not copy. Select the description and copy it yourself.'); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || working || problems.length) return;
    if (await onSave(draft, saveDefaults)) onClose();
  }
  async function approve() {
    if (!onApprove || disabled || problems.length) return;
    if (await onApprove(draft, saveDefaults)) onClose();
  }

  return <form className="card library-panel post-panel" aria-label={`Post ${video.title}`} onSubmit={(event) => void save(event)}>
    <div className="post-panel-head"><label htmlFor={id('caption')}>Description</label>
      <button type="button" className="ghost-button small-button" disabled={suggesting} onClick={() => void suggest()}>{suggesting ? <><Loader2 size={14} className="spin"/> Writing…</> : <><Sparkles size={14}/> Suggest with AI</>}</button></div>
    <textarea id={id('caption')} rows={3} maxLength={5000} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="What the video is about. It goes out as the caption, and as the description on YouTube."/>
    <label htmlFor={id('tags')}>Hashtags</label>
    <input id={id('tags')} value={tags} onChange={(event) => setTags(event.target.value)} onBlur={() => setTags(hashtagText(parseHashtags(tags)))} placeholder="#bunny #cute #snow"/>
    <p className="library-hint">{parseHashtags(tags).length} hashtags · {text.length} characters{socials.length ? ` (limits: ${socials.map((platform) => `${getPlatform(platform).name} ${LIMITS[platform].text.toLocaleString()}`).join(', ')})` : ''}. Hashtags go after the description.</p>
    <label className="check-row"><input type="checkbox" checked={saveDefaults} onChange={(event) => setSaveDefaults(event.target.checked)}/> Start new {category.name} videos with this description and these hashtags</label>
    {socials.includes('youtube') && <><label htmlFor={id('yt-title')}>YouTube title</label><input id={id('yt-title')} maxLength={YOUTUBE_TITLE_LIMIT} value={details.youtubeTitle} onChange={(event) => set({ youtubeTitle: event.target.value })}/></>}
    {isLocalVideo(video.mediaSource) && <CoverPicker path={video.mediaSource} value={details.coverMs} onChange={(coverMs) => set({ coverMs })}/>}
    <div className="details-checks">
      <label className="check-row"><input type="checkbox" checked={details.madeWithAi} onChange={(event) => set({ madeWithAi: event.target.checked })}/> Made with AI (labeled as AI-generated on YouTube and TikTok)</label>
      {socials.includes('instagram') && <label className="check-row"><input type="checkbox" checked={details.shareToFeed} onChange={(event) => set({ shareToFeed: event.target.checked })}/> Also show the Instagram Reel in the main feed</label>}
      {socials.includes('youtube') && <label className="check-row"><input type="checkbox" checked={details.madeForKids} onChange={(event) => set({ madeForKids: event.target.checked })}/> Made for kids (YouTube asks this of every video)</label>}
    </div>

    {socials.length > 0 && <div className="post-targets" aria-label="Where it goes">
      <span className="cover-label">Where it goes</span>
      {socials.map((platform) => {
        const name = getPlatform(platform).name;
        const done = video.posted.includes(platform);
        let state: React.ReactNode;
        if (done) state = video.testPosts?.[platform] !== undefined ? <span className="pill planned"><span className="dot"/>Posted as a test</span> : <span className="pill active"><span className="dot"/>Posted</span>;
        else if (API_SOCIALS.includes(platform)) {
          if (automatic) state = <span className="post-target-note">Posts automatically as @{instagram?.username}</span>;
          else if (instagram?.connected === null) state = <span className="post-target-note">Checking the connection…</span>;
          else if (instagram?.connected && !instagram.canUploadFiles) state = <span className="post-target-note">Connected with an Instagram login, which can't upload a video from this PC. Disconnect and connect again under Profiles to sign in through Meta.</span>;
          else state = <>{<span className="post-target-note">Not connected yet</span>}{onConnectInstagram && <button type="button" className="outline-button small-button" onClick={onConnectInstagram}><Link2 size={14}/> Connect</button>}</>;
        } else if (onPostOnPage) state = <><span className="post-target-note">{postModeNote(marks, platform)}</span>
          <button type="button" className="outline-button small-button" disabled={busy || problems.length > 0} onClick={() => void onPostOnPage(draft, platform, saveDefaults)}><AppWindow size={14}/> Post on {name}</button></>;
        else state = <><span className="post-target-note">Not automatic yet: copy the text, open {name} and post it there, then tick it as posted.</span>
          <button type="button" className="ghost-button small-button" onClick={() => void copy()}>{copied ? <><Check size={14}/> Copied</> : 'Copy text'}</button>
          <button type="button" className="ghost-button small-button" disabled={busy} onClick={() => onOpen(platform, 'post')}><AppWindow size={14}/> Open {name}</button></>;
        return <div className="post-target" key={platform}><BrandMark platform={platform} small/><strong>{name}</strong>{state}</div>;
      })}
    </div>}

    {problems.map((problem) => <div key={problem} className="error-message" role="alert">{problem}</div>)}
    {(error || postError) && <div className="error-message" role="alert">{error || postError}</div>}
    <div className="library-panel-buttons">
      <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
      <button className={automatic ? 'outline-button' : 'primary-button'} disabled={disabled || working || problems.length > 0}>Save</button>
      {automatic && <button type="button" className="primary-button" disabled={disabled || working || problems.length > 0} onClick={() => void approve()}>{working ? <><Loader2 size={15} className="spin"/> Posting…</> : <><Send size={15}/> Approve and post</>}</button>}
    </div>
  </form>;
}

/** Picks the cover as a moment of the video. Instagram and TikTok use that frame; YouTube picks its own unless the channel is verified. */
function CoverPicker({ path, value, onChange }: { path: string; value?: number; onChange: (ms: number | undefined) => void }) {
  const [src, setSrc] = useState('');
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let live = true;
    videoPreviewUrl(path).then((url) => { if (live) setSrc(url); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [path]);
  const ms = value ?? 0;
  function seek(next: number) {
    onChange(next);
    if (ref.current) ref.current.currentTime = next / 1000;
  }
  return <div className="cover-picker">
    <span className="cover-label">Cover</span>
    {failed ? <p className="library-hint">This video can't be previewed here, so the cover is its first frame.</p> : <div className="cover-row">
      {src ? <video ref={ref} src={src} muted preload="metadata" aria-label="Cover frame" onLoadedMetadata={(event) => { const video = event.currentTarget; setDuration(Math.floor(video.duration * 1000) || 0); video.currentTime = ms / 1000; }}/> : <div className="cover-loading"><Loader2 size={16} className="spin"/></div>}
      <div className="cover-controls">
        <input type="range" aria-label="Cover moment" min={0} max={Math.max(duration, 0)} step={100} value={Math.min(ms, duration || ms)} disabled={!duration} onChange={(event) => seek(Number(event.target.value))}/>
        <small>{value == null ? 'First frame' : `Frame at ${formatMs(ms)}`}{value != null && <button type="button" className="text-button" onClick={() => { seek(0); onChange(undefined); }}>Use first frame</button>}</small>
      </div>
    </div>}
  </div>;
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
    const start = newPost(category, false);
    const video: Video = { id: crypto.randomUUID(), brandId, categoryId: category.id, title: title.trim(), mediaSource: mediaSource.trim(), posted: [], createdAt: Date.now(), ...start, caption: caption.trim() || start.caption };
    void onSave(video).then((ok) => { if (ok) onClose(); });
  }
  return <form className="card library-panel" onSubmit={submit} aria-label={`Add a video to ${category.name}`}>
    <div className="field-row">
      <div><label htmlFor="video-file">Video file</label><div className="media-picker"><input id="video-file" value={mediaSource} maxLength={1000} onChange={(event) => setMediaSource(event.target.value)} placeholder="Choose a file"/><button type="button" className="outline-button" disabled={disabled} onClick={() => void pickFile()}><FolderOpen size={15}/> Browse</button></div></div>
      <div><label htmlFor="video-title">Title</label><input id="video-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} required/></div>
    </div>
    {showCaption ? <><label htmlFor="video-caption">Description</label><textarea id="video-caption" rows={2} maxLength={5000} value={caption} onChange={(event) => setCaption(event.target.value)}/></>
      : <button type="button" className="library-more" onClick={() => setShowCaption(true)}><ChevronDown size={14}/> Add a description</button>}
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
