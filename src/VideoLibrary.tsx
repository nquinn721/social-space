import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { AlertCircle, AppWindow, Check, ChevronDown, ExternalLink, Film, FolderOpen, Link2, Loader2, Pencil, Play, Plus, RotateCw, Send, Sparkles, Trash2, Type, X } from 'lucide-react';
import { getPlatform, PLATFORMS, type Platform, type PlatformAction, type PostDetails, type TextEdit, type Video, type VideoCategory, type Workspace } from './model';
import { chooseVideoFile } from './queueService';
import { BrandMark, errorText, PageHeader } from './ui';
import { ASPECT_RATIOS, PROVIDERS } from './videoProviders';
import { DESKTOP_ONLY, listVideoSources, type SourcesState } from './videoSourcesService';
import { useVideoGenerations } from './useVideoGenerations';
import { publishVideoToInstagram, useBrandInstagram, type BrandInstagram } from './useBrandInstagram';
import { isLocalVideo, openVideoFile, showVideoInFolder, videoPreviewUrl } from './videoFileService';
import { detailProblems, detailsOf, formatMs, newPost, hashtagText, LIMITS, parseHashtags, postText, startingPost, STAGES, videoStage, YOUTUBE_TITLE_LIMIT, type Stage } from './postDetails';
import { cachedPostSuggestion, suggestPost, type PostSuggestion } from './assistant/postSuggest';
import { GhostInput, GhostTextarea } from './GhostText';
import { useConfirm } from './ConfirmDialog';
import { openInstagramPost } from './instagramService';
import { openFacebookPost } from './facebookService';
import { publishVideoToFacebook, useBrandFacebook, type BrandFacebook } from './useBrandFacebook';
import PartnerReviewControls from './PartnerReviewControls';
import { useBrowserPosting } from './useBrowserPosting';
import { progressLabel, useBrandStatuses, videoProgress, type SocialStatus, type Tone } from './brandStatus';
import { API_UPLOADS, postModeNote } from './postingMode';
import { testModeOf, withPosted } from './appReviews';
import { earlierPartMissing, videoPartLabel, waitingOnEarlierPart } from './series';
import { batchPlan, preparationSignature, type BatchDestination } from './batchPosting';
import { beginAttempt, clearAttempt, readAttempt, recordPublished } from './publishAttempt';
import VideoIdeasDialog from './VideoIdeasDialog';
import VideoTextEditor from './VideoTextEditor';
import { useVideoIdeas } from './useVideoIdeas';
import './library.css';
import './series.css';

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
  /** Opens the pre-filled sign-up for the brand's profile on a social it isn't live on yet. */
  onCreateProfile?: (platform: Platform) => void;
  /** Goes to the brand's Accounts, where logins are saved and fixed. */
  onShowAccounts?: () => void;
  /** The brand's Instagram connection when the page already checks it, so it isn't checked twice. */
  instagram?: BrandInstagram | null;
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
/** "3 videos · 2 posts to make · 1 posted everywhere": what is left in a category, counted per social. */
export function categoryLine(videos: Video[], socials: Platform[]) {
  const parts = [plural(videos.length, 'video')];
  if (socials.length && videos.length) {
    const ready = videos.filter((video) => !video.generation);
    const left = ready.reduce((sum, video) => sum + socials.filter((platform) => !video.posted.includes(platform)).length, 0);
    const everywhere = categoryProgress(videos, socials).everywhere;
    parts.push(left ? `${plural(left, 'post')} to make` : 'nothing left to post');
    if (everywhere) parts.push(`${everywhere} posted everywhere`);
  }
  return parts.join(' · ');
}

/**
 * A brand's videos, grouped into categories, moving from Making to Review to Ready to Posted.
 * Videos can be added from a file or made with an AI video source; each has its own post details.
 */
export default function VideoLibrary({ workspace, loaded, busy, onSave, onOpen, onManageSources, brandId: fixedBrand, onConnectInstagram, onCreateProfile, onShowAccounts, instagram: givenInstagram }: Props) {
  const brands = workspace.brands;
  const categories = workspace.categories ?? [];
  const videos = workspace.videos ?? [];
  const [brandId, setBrandId] = useState(fixedBrand ?? brands[0]?.id ?? '');
  const brand = brands.find((item) => item.id === (fixedBrand ?? brandId)) ?? (fixedBrand ? undefined : brands[0]);
  const ownInstagram = useBrandInstagram(workspace, givenInstagram === undefined ? brand?.id : undefined);
  const instagram = givenInstagram === undefined ? ownInstagram : givenInstagram;
  const brandCategories = categories.filter((category) => category.brandId === brand?.id);
  const [categoryId, setCategoryId] = useState('');
  const category = brandCategories.find((item) => item.id === categoryId) ?? brandCategories[0];
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [stage, setStage] = useState<Stage | 'all'>('all');
  const [error, setError] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [, setAttemptRevision] = useState(0);
  const refreshAttempts = () => setAttemptRevision((value) => value + 1);
  const batchGuard = useRef(false);
  const latestWorkspace = useRef(workspace);
  latestWorkspace.current = workspace;
  useEffect(() => {
    for (const video of workspace.videos ?? []) for (const platform of ['instagram', 'facebook'] as const) {
      if (video.posted.includes(platform) && readAttempt(video.id, platform)?.state === 'posted') {
        try { clearAttempt(video.id, platform); } catch { /* A leftover marker is safer than allowing a duplicate. */ }
      }
    }
  }, [workspace.videos]);
  const generations = useVideoGenerations(workspace, onSave);
  const browser = useBrowserPosting(workspace, onSave);
  const latestBrowser = useRef(browser);
  latestBrowser.current = browser;
  const socials = brand ? brandSocials(workspace, brand.id) : [];
  const statuses = useBrandStatuses(workspace, brand?.id, instagram);
  const facebook = useBrandFacebook(workspace, brand?.id);
  /** The one step that unblocks a social: make the profile, or fix its login or connection under Accounts. */
  function fix(status: SocialStatus) {
    const kind = status.action?.kind;
    if ((kind === 'create' || kind === 'finish-signup') && onCreateProfile) onCreateProfile(status.platform);
    else if (kind === 'connect' && onConnectInstagram) onConnectInstagram();
    else (onShowAccounts ?? onConnectInstagram)?.();
  }
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
  /** Record a result against the latest workspace, keeping any unrelated edits made during upload. */
  async function savePublished(draft: Video, original: Video, platform: 'instagram' | 'facebook', link?: string, defaults?: { value: VideoCategory['defaults'] }, message?: string) {
    const current = latestWorkspace.current;
    const video = current.videos?.find((item) => item.id === draft.id);
    if (!video) return false;
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    const updated = { ...video,
      caption: same(video.caption, original.caption) ? draft.caption : video.caption,
      details: same(video.details, original.details) ? draft.details : video.details,
      links: link ? { ...video.links, [platform]: link } : video.links,
    };
    const posted = video.posted.includes(platform) ? video.posted : [...video.posted, platform];
    const categories = defaults && current.categories?.map((category) => category.id === draft.categoryId && same(category.defaults, defaults.value)
      ? { ...category, defaults: { caption: draft.caption, hashtags: draft.details?.hashtags ?? [] } } : category);
    return onSave({ ...current, videos: current.videos?.map((item) => item.id === draft.id ? withPosted(updated, posted, current.setup) : item), ...(categories ? { categories } : {}) }, message ?? `Recorded "${draft.title}" as posted on ${getPlatform(platform).name}.`);
  }
  async function publish(draft: Video, platform: 'instagram' | 'facebook', saveDefaults: boolean, message: string, send: () => Promise<{ permalink?: string }>) {
    if (batchGuard.current) throw new Error('Posting windows are already being prepared.');
    const original = latestWorkspace.current.videos?.find((item) => item.id === draft.id);
    if (!original || original.posted.includes(platform)) throw new Error('Review this video before posting again.');
    const defaults = saveDefaults ? { value: latestWorkspace.current.categories?.find((category) => category.id === draft.categoryId)?.defaults } : undefined;
    try { beginAttempt(draft.id, platform); }
    catch { throw new Error('A previous attempt needs review, or this PC could not save a safety marker. Check the social before trying again.'); }
    refreshAttempts();
    let link: string | undefined;
    try { link = (await send()).permalink; }
    catch (reason) { throw new Error(`${errorText(reason)} ${getPlatform(platform).name} did not confirm the result. Check the social before trying again.`); }
    try { recordPublished(draft.id, platform, link); } catch { /* The earlier pending marker still blocks another attempt. */ }
    refreshAttempts();
    let saved = false;
    try { saved = !!(await savePublished(draft, original, platform, link, defaults, message)); } catch { /* The provider already succeeded; retain its marker. */ }
    if (!saved) throw new Error(`Published on ${getPlatform(platform).name}, but Social Space could not save its status. Use Mark posted below; do not post again.`);
  }
  async function post(draft: Video, saveDefaults: boolean) {
    if (!instagram) throw new Error('Connect Instagram first.');
    await publish(draft, 'instagram', saveDefaults, `Posted "${draft.title}" to @${instagram.username} on Instagram.`, () => publishVideoToInstagram(instagram, draft));
  }
  async function postFacebook(draft: Video, saveDefaults: boolean) {
    if (!facebook?.connected) throw new Error('Connect Facebook first.');
    await publish(draft, 'facebook', saveDefaults, `Posted "${draft.title}" as a Reel on the Facebook Page ${facebook.page}.`, () => publishVideoToFacebook(facebook, draft));
  }
  async function resolveAttempt(video: Video, platform: 'instagram' | 'facebook', posted: boolean) {
    const attempt = readAttempt(video.id, platform);
    if (!attempt) return;
    if (posted) {
      recordPublished(video.id, platform, attempt.link);
      if (!(await savePublished(video, video, platform, attempt.link))) throw new Error('Could not save the posted status. Try again.');
    } else clearAttempt(video.id, platform);
    refreshAttempts();
  }
  /** Opens manual publishing windows after checking the approved plan is still current. */
  async function preparePosts(video: Video, plan: BatchDestination[]) {
    if (batchGuard.current) throw new Error('Posting windows are already being prepared.');
    batchGuard.current = true;
    setBatchBusy(true);
    try {
      for (const destination of plan) {
        if (destination.method !== 'browser' && destination.method !== 'manual') continue;
        const currentWorkspace = latestWorkspace.current;
        const current = currentWorkspace.videos?.find(item => item.id === video.id);
        if (!current || current.generation || preparationSignature(current) !== preparationSignature(video)) throw new Error('The video changed. Review it again before opening posting windows.');
        if (current.posted.includes(destination.platform)) throw new Error(`${getPlatform(destination.platform).name} is already marked posted. Review the destinations again; any windows already opened remain open.`);
        const order = waitingOnEarlierPart(currentWorkspace, current, destination.platform);
        if (order) throw new Error(order);
        const account = currentWorkspace.accounts.find(item => item.brandId === current.brandId && item.platform === destination.platform && item.status === 'active');
        if (!brandSocials(currentWorkspace, current.brandId).includes(destination.platform) || !account || account.id !== destination.accountId || JSON.stringify(account) !== destination.accountSnapshot) throw new Error(`The ${getPlatform(destination.platform).name} account changed. Review the destinations again.`);
        if (latestBrowser.current.isOpen(current.id, destination.platform) || latestBrowser.current.isAsking(current.id, destination.platform)) throw new Error(`Check the existing ${getPlatform(destination.platform).name} posting window first.`);
        await latestBrowser.current.post(current, destination.platform);
      }
    } finally { batchGuard.current = false; setBatchBusy(false); }
  }
  /**
   * Records a video saved by the text editor: a new video in the same category with the post text carried over,
   * or, when changing the text of a text video that isn't posted anywhere yet, that same video with the new file.
   */
  function saveTextVideo(video: Video, path: string, edit: TextEdit) {
    const current = latestWorkspace.current;
    const list = current.videos ?? [];
    const existing = list.find((item) => item.id === video.id);
    if (existing?.textEdit && existing.posted.length === 0) {
      return onSave({ ...current, videos: list.map((item) => item.id === video.id ? { ...item, mediaSource: path, textEdit: edit } : item) }, `Saved the new text on "${video.title}".`);
    }
    const made: Video = { id: crypto.randomUUID(), brandId: video.brandId, categoryId: video.categoryId, title: `${video.title} with text`, mediaSource: path, caption: video.caption, posted: [], createdAt: Date.now(),
      ...(video.details ? { details: video.details } : {}), ...(video.prompt ? { prompt: video.prompt } : {}), textEdit: edit };
    return onSave({ ...current, videos: [...list, made] }, `Saved "${made.title}" in ${current.categories?.find((item) => item.id === video.categoryId)?.name ?? 'the category'}.`);
  }
  function removeVideo(video: Video) {
    const note = video.generation?.status === 'working' ? ' The source may still finish it, but it will not be saved here.' : ' This does not delete it from any social or from your PC.';
    if (disabled || !window.confirm(`Remove "${video.title}" from ${category?.name}?${note}`)) return;
    void save({ videos: videos.filter((item) => item.id !== video.id) }, `Removed "${video.title}".`);
  }

  const header = fixedBrand ? null : <PageHeader title="Video library" description="Each brand's videos, grouped into categories. Add a file or make one with AI, then post it to the brand's socials."/>;
  if (!brand) return <>{header}<section className="card empty-state"><div className="empty-icon"><Film size={22}/></div><strong>No brands yet</strong><p>Create accounts for a brand first. Its categories and videos show up here.</p></section></>;
  const brandNotes = [brand.notes, ...workspace.accounts.filter((account) => account.brandId === brand.id).map((account) => account.bio ?? '')].filter(Boolean).join('\n').slice(0, 3000);
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
            <div><h2>{category.name}</h2><p>{categoryLine(inCategory, socials)}</p></div>
            <div className="library-actions">
              <button type="button" className={panel === 'make' ? 'outline-button' : 'primary-button'} aria-expanded={panel === 'make'} onClick={() => setPanel(panel === 'make' ? null : 'make')}><Sparkles size={15}/> Make a video</button>
              <button type="button" className="outline-button" aria-expanded={panel === 'add'} onClick={() => setPanel(panel === 'add' ? null : 'add')}><Plus size={15}/> Add a file</button>
            </div>
          </div>
          {panel === 'make' && <MakeVideo key={category.id} brandName={brand.name} brandNotes={brandNotes} category={category} disabled={disabled} onMake={generations.make} onClose={() => setPanel(null)} onManageSources={onManageSources}/>}
          {panel === 'add' && <AddVideo key={category.id} brandId={brand.id} category={category} disabled={disabled} onSave={(video) => save({ videos: [...videos, video] }, `Added "${video.title}" to ${category.name}.`)} onClose={() => setPanel(null)}/>}
          {socials.length === 0 && <p className="library-hint">{brand.name} has no social profiles yet, so there is nowhere to post. Add them under Accounts.</p>}
          {inCategory.length > 0 && <div className="segmented library-stages" role="group" aria-label="Stage">
            <button type="button" aria-pressed={stage === 'all'} onClick={() => setStage('all')}>All <small>{inCategory.length}</small></button>
            {STAGES.map(({ id, label }) => <button type="button" key={id} aria-pressed={stage === id} onClick={() => setStage(id)}>{label} <small>{counts[id]}</small></button>)}
          </div>}
          {inCategory.length === 0 ? <div className="library-empty">No videos in {category.name} yet. Make one with AI or add a file.</div>
            : shown.length === 0 ? <div className="library-empty">Nothing in {STAGES.find((item) => item.id === stage)?.label} right now.</div> : <ul className="library-videos">
            {shown.map((video) => <VideoRow key={video.id} video={video} socials={socials} busy={busy || batchBusy} disabled={disabled || batchBusy} progress={generations.progress[video.id]}
              onToggle={(platform) => togglePosted(video, platform)} onOpen={onOpen} onRemove={() => removeVideo(video)} onRetry={() => generations.retry(video)}
              category={category} brandName={brand.name} brandNotes={brandNotes} onSaveText={(path, edit) => saveTextVideo(video, path, edit)} onSavePost={(draft, defaults) => savePost(draft, defaults, `Saved the post details of "${draft.title}".`)}
              instagram={instagram} onPost={post} facebook={facebook} onPostFacebook={postFacebook} onConnectInstagram={onConnectInstagram} browser={browser} marks={workspace.setup} statuses={statuses} onFix={fix} onPreparePosts={preparePosts} onResolveAttempt={resolveAttempt}
              part={videoPartLabel(workspace, video)} waitingOn={(platform) => waitingOnEarlierPart(workspace, video, platform)} earlierPart={(platform) => earlierPartMissing(workspace, video, platform)}/>)}
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

type RowProps = { video: Video; category: VideoCategory; brandName: string; brandNotes?: string; onSaveText?: (path: string, edit: TextEdit) => Promise<boolean | undefined>; socials: Platform[]; busy: boolean; disabled: boolean; progress?: string; onToggle: (platform: Platform) => void; onOpen: Props['onOpen']; onRemove: () => void; onRetry: () => void;
  onSavePost?: (draft: Video, saveDefaults: boolean) => Promise<boolean | undefined>;
  instagram?: BrandInstagram | null; onPost?: (draft: Video, saveDefaults: boolean) => Promise<void>; onConnectInstagram?: () => void;
  /** The brand's Facebook Page, and posting a Reel to it through the API. */
  facebook?: BrandFacebook | null; onPostFacebook?: (draft: Video, saveDefaults: boolean) => Promise<void>;
  onPreparePosts: (video: Video, plan: BatchDestination[]) => Promise<void>;
  onResolveAttempt: (video: Video, platform: 'instagram' | 'facebook', posted: boolean) => Promise<void>;
  browser?: BrowserPosting; marks?: Record<string, number>; statuses: SocialStatus[]; onFix: (status: SocialStatus) => void;
  /** For a series episode: "Part 2 of 5", and why it can't go up on a social before an earlier part. */
  part?: string | null; waitingOn?: (platform: Platform) => string | null; earlierPart?: (platform: Platform) => number | null };
/**
 * One video as a post: its picture and text on the left, and a tile for every social of the brand that
 * says where it stands there (posted, ready, or what's missing) with the one button that moves it on.
 */
function VideoRow({ video, category, brandName, brandNotes = '', onSaveText, socials, busy, disabled, progress, onToggle, onOpen, onRemove, onRetry, onSavePost, instagram, onPost, facebook, onPostFacebook, onConnectInstagram, browser, marks, statuses, onFix, part, waitingOn, earlierPart, onPreparePosts, onResolveAttempt }: RowProps) {
  const job = video.generation;
  const fileName = video.mediaSource.split(/[\\/]/).pop();
  const playable = !job && isLocalVideo(video.mediaSource);
  const [watching, setWatching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingText, setAddingText] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const manualGuard = useRef(false);
  const [error, setError] = useState('');
  const [batchMessage, setBatchMessage] = useState('');
  const actionGuard = useRef(false);
  const automatic = canPostAutomatically(video, socials, instagram, !!onPost);
  const tags = detailsOf(video).hashtags;
  const { confirm, dialog } = useConfirm();
  const instagramLink = video.links?.instagram;
  const done = videoProgress(video, socials);
  const openPost = () => { if (instagramLink) openInstagramPost(instagramLink).catch((reason) => setError(errorText(reason))); };
  const facebookLink = video.links?.facebook;
  const openReel = () => { if (facebookLink) openFacebookPost(facebookLink).catch((reason) => setError(errorText(reason))); };
  const facebookReady = !job && API_SOCIALS.includes('facebook') && !!onPostFacebook && !!facebook?.connected && isLocalVideo(video.mediaSource);
  const plan = batchPlan({ video, socials, statuses, instagramReady: automatic, facebookReady, browserAvailable: !!browser,
    isOpen: platform => !!browser?.isOpen(video.id, platform), isAsking: platform => !!browser?.isAsking(video.id, platform),
    waitingOn: platform => waitingOn?.(platform) ?? null });
  const eligible = plan.filter(item => item.method === 'browser' || item.method === 'manual');
  async function startBatch() {
    if (actionGuard.current || busy || working || !eligible.length) return;
    actionGuard.current = true;
    setConfirming(true);
    try {
      const problems = detailProblems(video, socials);
      if (problems.length) { setEditing(true); setError(problems[0]); return; }
      const ok = await confirm({ title: `Prepare "${video.title}"?`,
        body: <><p>Review the destinations for <strong>{brandName}</strong>.</p><ul>{plan.map(item => <li key={item.platform}><strong>{getPlatform(item.platform).name}:</strong> {item.reason}</li>)}</ul><p>Check the account and publish in each window.</p></>,
        confirmLabel: 'Open posting windows' });
      if (!ok) return;
      setWorking(true); setError(''); setBatchMessage('');
      try { await onPreparePosts(video, plan); setBatchMessage('Posting windows opened. Check each account and publish there.'); }
      catch (reason) { setError(errorText(reason, 'Could not finish preparing all destinations.')); }
      finally { setWorking(false); }
    } finally { actionGuard.current = false; setConfirming(false); }
  }
  const statusOf = (platform: Platform) => statuses.find((status) => status.platform === platform)!;
  async function manualX(action: 'caption' | 'file') {
    if (manualGuard.current || busy || working) return;
    manualGuard.current = true; setManualBusy(true); setError('');
    try {
      if (action === 'caption') await navigator.clipboard.writeText(postText(video));
      else await showVideoInFolder(video.mediaSource);
    } catch (reason) { setError(errorText(reason, action === 'caption' ? 'Could not copy the caption.' : 'Could not locate the video.')); }
    finally { manualGuard.current = false; setManualBusy(false); }
  }
  async function unmark(platform: Platform) {
    const name = getPlatform(platform).name;
    if (await confirm({ title: `Mark as not posted on ${name}?`, body: <p>"{video.title}" goes back to waiting for {name}. Nothing is removed from {name}.</p>, confirmLabel: 'Mark as not posted' })) onToggle(platform);
  }
  /** Posting to Instagram goes straight out through the API, after one confirmation. */
  async function approve(draft: Video, saveDefaults: boolean) {
    if (!onPost || !instagram || working || busy || actionGuard.current || readAttempt(draft.id, 'instagram')) return false;
    actionGuard.current = true; setConfirming(true);
    try {
    const order = waitingOn?.('instagram');
    if (order) { setError(order); return false; }
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
    } finally { actionGuard.current = false; setConfirming(false); }
  }
  /** Posting a Reel to the brand's Facebook Page also goes straight out through the API, after one confirmation. */
  async function approveFacebook(draft: Video, saveDefaults: boolean) {
    if (!onPostFacebook || !facebook?.connected || working || busy || actionGuard.current || readAttempt(draft.id, 'facebook')) return false;
    actionGuard.current = true; setConfirming(true);
    try {
    const order = waitingOn?.('facebook');
    if (order) { setError(order); return false; }
    const problems = detailProblems(draft, socials);
    if (problems.length) { setEditing(true); setError(problems[0]); return false; }
    const caption = postText(draft);
    const ok = await confirm({
      title: `Post "${draft.title}" to Facebook?`,
      body: <><p>It goes live as a Reel on the Page <strong>{facebook.page}</strong> right away. Facebook takes Reels of 3 to 90 seconds in 9:16.</p>{caption ? <p className="confirm-caption">{caption}</p> : <p className="post-empty">No description.</p>}</>,
      confirmLabel: 'Post to Facebook',
    });
    if (!ok) return false;
    setWorking(true); setError('');
    try { await onPostFacebook(draft, saveDefaults); return true; }
    catch (reason) { setError(errorText(reason, 'Facebook did not publish this video.')); return false; }
    finally { setWorking(false); }
    } finally { actionGuard.current = false; setConfirming(false); }
  }
  /** Opens the social's upload page with this post filled in, after saving any edits. */
  async function postOnPage(draft: Video, platform: Platform, saveDefaults = false) {
    if (!browser || !onSavePost || actionGuard.current || busy || working) return false;
    actionGuard.current = true; setWorking(true);
    try {
    const order = waitingOn?.(platform);
    if (order) { setError(order); return false; }
    const problems = detailProblems(draft, socials);
    if (problems.length) { setEditing(true); setError(problems[0]); return false; }
    setError('');
    try {
      const saved = JSON.stringify({ caption: video.caption, details: video.details }) === JSON.stringify({ caption: draft.caption, details: draft.details });
      if ((!saved || saveDefaults) && !(await onSavePost(draft, saveDefaults))) return false;
      await browser.post(draft, platform);
      return true;
    } catch (reason) { setError(errorText(reason, `Could not open the ${getPlatform(platform).name} upload page.`)); return false; }
    } finally { actionGuard.current = false; setWorking(false); }
  }

  async function resolve(platform: 'instagram' | 'facebook', posted: boolean) {
    if (actionGuard.current || busy || working) return;
    actionGuard.current = true; setConfirming(true);
    try {
      const ok = await confirm({ title: posted ? `Mark as posted on ${getPlatform(platform).name}?` : `Try ${getPlatform(platform).name} again?`,
        body: <p>{posted ? 'Confirm this video is already on the account.' : 'Only continue if you checked the account and this video is not there. Otherwise posting again could create a duplicate.'}</p>,
        confirmLabel: posted ? 'Mark posted' : 'It is not there' });
      if (!ok) return;
      setWorking(true); setError('');
      try { await onResolveAttempt(video, platform, posted); }
      catch (reason) { setError(errorText(reason, 'Could not update the posting status.')); }
      finally { setWorking(false); }
    } finally { actionGuard.current = false; setConfirming(false); }
  }

  function destination(platform: Platform) {
    const name = getPlatform(platform).name;
    const status = statusOf(platform);
    const posted = video.posted.includes(platform);
    let tone: Tone = status.tone;
    // Long labels ("Connected as @someone") don't fit a tile: a short word here, the whole story in the tooltip.
    let line: React.ReactNode = status.kind === 'reconnect' && status.label.startsWith('Connected as') ? 'Wrong account' : status.label;
    let action: React.ReactNode = null;
    if (posted) {
      tone = 'ok';
      line = <>Posted{video.testPosts?.[platform] !== undefined && <span className="test-badge" title="Posted while this social's app was in test mode">Test</span>}</>;
      action = <>{platform === 'instagram' && instagramLink && <button type="button" className="dest-link" aria-label="View on Instagram" onClick={openPost}>View</button>}
        {platform === 'facebook' && facebookLink && <button type="button" className="dest-link" aria-label="View on Facebook" onClick={openReel}>View</button>}
        <button type="button" className="dest-link quiet" disabled={disabled} aria-label={`Mark as not posted on ${name}`} title={`Mark as not posted on ${name}`} onClick={() => void unmark(platform)}>Undo</button></>;
    } else if ((platform === 'instagram' || platform === 'facebook') && readAttempt(video.id, platform)) {
      const attempt = readAttempt(video.id, platform);
      tone = 'problem'; line = attempt?.state === 'posted' ? 'Published · save status' : 'Check whether it posted';
      action = <><button type="button" className="dest-button primary" disabled={busy || working || confirming} onClick={() => void resolve(platform, true)}>Mark posted</button>
        {attempt?.state !== 'posted' && <button type="button" className="dest-link quiet" disabled={busy || working || confirming} onClick={() => void resolve(platform, false)}>Not posted</button>}</>;
    } else if (job) {
      tone = 'muted'; line = job.status === 'failed' ? 'No video to post' : 'Waits for the video';
    } else if (earlierPart?.(platform)) {
      tone = 'muted'; line = `After Part ${earlierPart(platform)}`;
    } else if (browser?.isAsking(video.id, platform)) {
      tone = 'todo'; line = 'Did it go up?';
      action = <><button type="button" className="dest-button primary" aria-label={`Yes, it's on ${name}`} disabled={disabled || browser.isConfirming} onClick={() => void browser.confirm({ videoId: video.id, platform }, true)}><Check size={13}/> Yes</button>
        <button type="button" className="dest-link quiet" disabled={disabled || browser.isConfirming} onClick={() => void browser.confirm({ videoId: video.id, platform }, false)}>Not yet</button>{browser.confirmationError(video.id, platform) && <span className="error-message" role="alert">{browser.confirmationError(video.id, platform)}</span>}</>;
    } else if (status.canPost && platform === 'facebook' && API_SOCIALS.includes(platform)) {
      if (facebookReady) { tone = 'ready'; line = `Posts to ${facebook?.page}`; action = <button type="button" className="dest-button primary" aria-label="Post to Facebook" disabled={busy || working || confirming} onClick={() => void approveFacebook(video, false)}>{working ? <><Loader2 size={13} className="spin"/> Posting…</> : <><Send size={13}/> Post</>}</button>; }
      else { tone = 'todo'; line = isLocalVideo(video.mediaSource) ? 'Connected' : 'Needs a video file'; }
    } else if (status.canPost && platform === 'instagram' && API_SOCIALS.includes(platform)) {
      if (automatic) { tone = 'ready'; line = `Posts as @${instagram?.username}`; action = <button type="button" className="dest-button primary" aria-label="Post to Instagram" disabled={busy || working || confirming} onClick={() => void approve(video, false)}>{working ? <><Loader2 size={13} className="spin"/> Posting…</> : <><Send size={13}/> Post</>}</button>; }
      else { tone = 'todo'; line = isLocalVideo(video.mediaSource) ? 'Connected, can\'t upload' : 'Needs a video file'; }
    } else if (status.canPost && browser) {
      const open = browser.isOpen(video.id, platform);
      tone = 'todo'; line = open ? 'Window open' : status.label;
      action = <><button type="button" className="dest-button primary" aria-label={open ? `Open ${name} again` : `Post on ${name}`} disabled={busy || working || confirming} title={platform === 'x' ? 'Opens X; attach the video and write the post yourself.' : `Opens ${name}'s upload page. Check the account and publish there.`} onClick={() => void postOnPage(video, platform)}><AppWindow size={13}/> {open ? 'Open again' : 'Post'}</button>{platform === 'x' && <><button type="button" className="dest-link" disabled={busy || working || manualBusy} aria-label="Copy X caption" onClick={() => void manualX('caption')}>Copy caption</button><button type="button" className="dest-link" disabled={busy || working || manualBusy || !isLocalVideo(video.mediaSource)} aria-label="Show X video in folder" onClick={() => void manualX('file')}>Show file</button></>}</>;
    } else if (status.action) {
      action = <button type="button" className="dest-button" aria-label={`${status.action.label} (${name})`} disabled={busy} title={status.detail} onClick={() => onFix(status)}>{status.action.short}</button>;
    }
    return <div key={platform} className={`dest tone-${tone}`} title={posted ? `Posted on ${name}` : status.detail}>
      <BrandMark platform={platform} small/>
      <div className="dest-text"><strong>{name}</strong><small>{line}</small></div>
      {action && <div className="dest-actions">{action}</div>}
    </div>;
  }

  return <li className={`library-video vcard ${job ? `is-${job.status}` : ''}`} aria-label={video.title}>
    <div className="vcard-main">
      <VideoThumb video={video} playable={playable} watching={watching} onToggle={() => setWatching(!watching)}/>
      <div className="vcard-body">
        <div className="vcard-top">
          <div className="library-video-titleline">{part && <span className="series-badge">{part}</span>}{playable ? <button type="button" className="library-video-title" onClick={() => setWatching(!watching)}>{video.title}</button> : <strong className="library-video-title">{video.title}</strong>}</div>
          <span className={`progress-pill state-${done.state}`}>{progressLabel(done)}</span>
          <div className="vcard-tools">
            {playable && onSaveText && <button type="button" className="ghost-button small-button" disabled={disabled} title="Put animated text on this video" onClick={() => setAddingText(true)}><Type size={14}/> {video.textEdit ? 'Edit text' : 'Add text'}</button>}
            {!job && onSavePost && <button type="button" className="ghost-button small-button" aria-expanded={editing} onClick={() => setEditing(!editing)}><Pencil size={14}/> Edit post</button>}
            {job && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={onRetry}><RotateCw size={14}/> {job.status === 'failed' ? 'Try again' : 'Check now'}</button>}
            <button type="button" className="icon-button" aria-label={`Remove ${video.title}`} title="Remove from Social Space" disabled={disabled} onClick={onRemove}><Trash2 size={15}/></button>
          </div>
        </div>
        {job?.status === 'working' && <p className="vcard-meta">Being made by {job.sourceName} ({PROVIDERS[job.provider]?.name ?? job.provider}){progress ? ` · ${progress}` : ''}. Saves here when ready.</p>}
        {job?.status === 'failed' && <p className="vcard-meta library-failed">{job.message || `${job.sourceName} could not make this video.`}</p>}
        {!job && !editing && <div className="vcard-caption" aria-label="Post">
          {video.caption.trim() ? <p>{video.caption.trim()}</p> : <p className="post-empty">No description yet. Edit the post or use Suggest with AI.</p>}
          {tags.length > 0 && <p className="post-tags">{hashtagText(tags)}</p>}
        </div>}
        {!job && <p className="vcard-meta" title={video.mediaSource}>{fileName || 'No file yet'}</p>}
      </div>
    </div>
    {socials.length > 0 && !editing && <div className="dest-grid" role="group" aria-label="Where it goes">{socials.map(destination)}</div>}
    {!job && !editing && <button type="button" className="primary-button small-button" disabled={disabled || working || confirming || eligible.length === 0} onClick={() => void startBatch()}><Send size={14}/> Prepare posting windows</button>}
    {batchMessage && <p className="library-hint" role="status">{batchMessage}</p>}
    {!editing && done.state !== 'making' && <PartnerReviewControls video={video} socials={socials} disabled={disabled || working}/>}
    {working && <p className="library-hint" role="status">Preparing this post. This can take a few minutes; keep the app open.</p>}
    {dialog}
    {error && !editing && <div className="error-message" role="alert">{error}</div>}
    {editing && onSavePost && <PostPanel video={video} category={category} brandName={brandName} socials={socials} busy={busy || working} disabled={disabled} instagram={instagram} onOpen={onOpen}
      error={error || (readAttempt(video.id, 'instagram') || readAttempt(video.id, 'facebook') ? 'Close the editor and check the posting status before trying again.' : '')} working={working} onSave={onSavePost} onApprove={onPost && !readAttempt(video.id, 'instagram') ? approve : undefined} facebookPage={facebook?.connected ? facebook.page : undefined} onApproveFacebook={facebookReady && !readAttempt(video.id, 'facebook') ? approveFacebook : undefined} onConnectInstagram={onConnectInstagram} onClose={() => { setEditing(false); setError(''); }}
      statuses={statuses} onFix={onFix} onPostOnPage={browser ? async (draft, platform, defaults) => { if (await postOnPage(draft, platform, defaults)) setEditing(false); } : undefined} marks={marks}/>}
    {playable && watching && <VideoPlayer path={video.mediaSource} title={video.title}/>}
    {addingText && onSaveText && <VideoTextEditor video={video} brandName={brandName} brandNotes={brandNotes} categoryName={category.name} onSaved={onSaveText} onClose={() => setAddingText(false)}/>}
  </li>;
}

/** The video's first frame (or its cover) as a thumbnail; plays it in the row when clicked. */
function VideoThumb({ video, playable, watching, onToggle }: { video: Video; playable: boolean; watching: boolean; onToggle: () => void }) {
  const [src, setSrc] = useState('');
  const job = video.generation;
  const cover = detailsOf(video).coverMs;
  useEffect(() => {
    if (!playable || !isTauri()) return;
    let live = true;
    videoPreviewUrl(video.mediaSource).then((url) => { if (live) setSrc(url); }).catch(() => undefined);
    return () => { live = false; };
  }, [video.mediaSource, playable]);
  const inner = src ? <video src={`${src}#t=${(cover ?? 500) / 1000}`} muted preload="metadata" aria-hidden="true"/>
    : <span className="vthumb-icon">{job?.status === 'working' ? <Loader2 size={18} className="spin"/> : job?.status === 'failed' ? <AlertCircle size={18}/> : <Film size={18}/>}</span>;
  if (!playable) return <div className={`vthumb ${job ? `is-${job.status}` : ''}`}>{inner}</div>;
  return <button type="button" className="vthumb" aria-label={`${watching ? 'Hide' : 'Play'} ${video.title}`} aria-expanded={watching} onClick={onToggle}>
    {inner}<span className="vthumb-play">{watching ? <X size={16}/> : <Play size={16}/>}</span>
  </button>;
}

/** Whether approving posts the video by itself: its Instagram post is still to do and the profile is connected through Meta. */
function canPostAutomatically(video: Video, socials: Platform[], instagram: BrandInstagram | null | undefined, canPost: boolean) {
  return !video.generation && canPost && API_SOCIALS.includes('instagram') && socials.includes('instagram') && !video.posted.includes('instagram')
    && !!instagram?.connected && instagram.canUploadFiles && isLocalVideo(video.mediaSource)
    // Never to an account other than the brand's own profile.
    && instagram.username.replace(/^@/, '').toLowerCase() === instagram.handle.replace(/^@/, '').toLowerCase();
}

type PanelProps = { video: Video; category: VideoCategory; brandName: string; socials: Platform[]; busy: boolean; disabled: boolean; instagram?: BrandInstagram | null; onOpen: Props['onOpen'];
  error: string; working: boolean; onSave: (draft: Video, saveDefaults: boolean) => Promise<boolean | undefined>; onApprove?: (draft: Video, saveDefaults: boolean) => Promise<boolean>; onConnectInstagram?: () => void; onClose: () => void;
  onPostOnPage?: (draft: Video, platform: Platform, saveDefaults: boolean) => Promise<void>; facebookPage?: string; onApproveFacebook?: (draft: Video, saveDefaults: boolean) => Promise<boolean>; marks?: Record<string, number>; statuses: SocialStatus[]; onFix: (status: SocialStatus) => void };
/**
 * Posting in one step: everything that goes out with the video (description, hashtags, cover, YouTube
 * title, labels), starting from the category's saved defaults, then where it goes and Post.
 */
function PostPanel({ video, category, brandName, socials, busy, disabled, instagram, onOpen, error: postError, working, onSave, onApprove, onConnectInstagram, onClose, onPostOnPage, facebookPage, onApproveFacebook, marks, statuses, onFix }: PanelProps) {
  const start = startingPost(video, category);
  const [caption, setCaption] = useState(start.caption);
  const [tags, setTags] = useState(hashtagText(start.details.hashtags));
  const [details, setDetails] = useState<PostDetails>(start.details);
  const [saveDefaults, setSaveDefaults] = useState(!category.defaults);
  const [suggesting, setSuggesting] = useState(false);
  const [ghost, setGhost] = useState<PostSuggestion | null>(null);
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

  // An empty description or hashtags box shows Grok's suggestion in grey (Tab takes it), fetched once per video.
  const needsGhost = !caption.trim() || !tags.trim();
  useEffect(() => {
    if (!needsGhost) return;
    let live = true;
    cachedPostSuggestion(video.id, { brand: brandName, category: category.name, title: video.title, prompt: video.prompt, socials: socials.map((platform) => getPlatform(platform).name), currentHashtags: parseHashtags(tags), limit })
      .then((idea) => { if (live) setGhost(idea); }).catch(() => undefined);
    return () => { live = false; };
  }, [video.id]);
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
    <GhostTextarea id={id('caption')} rows={3} maxLength={5000} value={caption} suggestion={ghost?.description} onAccept={setCaption} onChange={(event) => setCaption(event.target.value)} placeholder="What the video is about. It goes out as the caption, and as the description on YouTube."/>
    <label htmlFor={id('tags')}>Hashtags</label>
    <GhostInput id={id('tags')} value={tags} suggestion={ghost?.hashtags.length ? hashtagText(ghost.hashtags) : undefined} onAccept={setTags} onChange={(event) => setTags(event.target.value)} onBlur={() => setTags(hashtagText(parseHashtags(tags)))} placeholder="#bunny #cute #snow"/>
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
        else if (platform === 'facebook' && API_SOCIALS.includes(platform)) {
          const status = statuses.find((item) => item.platform === platform);
          if (onApproveFacebook) state = <><span className="post-target-note">Posts by itself as a Reel on the Page {facebookPage}.</span>
            <button type="button" className="outline-button small-button" disabled={disabled || working || problems.length > 0} onClick={() => void onApproveFacebook(draft, saveDefaults).then((ok) => { if (ok) onClose(); })}><Send size={14}/> Post to Facebook</button></>;
          else if (status?.canPost) state = <span className="post-target-note">Connected to {facebookPage}. Add a video file saved on this PC to post it.</span>;
          else state = <><span className="post-target-note">{status?.detail ?? 'Not connected yet.'}</span>{status?.action && <button type="button" className="outline-button small-button" onClick={() => onFix(status)}>{status.action.label}</button>}</>;
        } else if (API_SOCIALS.includes(platform)) {
          const status = statuses.find((item) => item.platform === platform);
          if (automatic) state = <span className="post-target-note">Posts by itself as @{instagram?.username} when you press Post.</span>;
          else if (instagram?.connected === null) state = <span className="post-target-note">Checking the connection…</span>;
          else if (instagram?.connected && !instagram.canUploadFiles) state = <span className="post-target-note">Connected with an Instagram login, which can't upload a video from this PC. Connect again through Meta under Accounts.</span>;
          else state = <><span className="post-target-note">{status?.detail ?? 'Not connected yet.'}</span>{onConnectInstagram && <button type="button" className="outline-button small-button" onClick={onConnectInstagram}><Link2 size={14}/> Connect</button>}</>;
        } else {
          const status = statuses.find((item) => item.platform === platform);
          if (status && !status.canPost) state = <><span className="post-target-note">{status.detail}</span>{status.action && <button type="button" className="outline-button small-button" onClick={() => onFix(status)}>{status.action.label}</button>}</>;
          else if (onPostOnPage) state = <><span className="post-target-note">{postModeNote(marks, platform)}</span>
            <button type="button" className="outline-button small-button" disabled={busy || problems.length > 0} onClick={() => void onPostOnPage(draft, platform, saveDefaults)}><AppWindow size={14}/> Post on {name}</button></>;
          else state = <><span className="post-target-note">Copy the text, open {name} and post it there, then mark it posted.</span>
            <button type="button" className="ghost-button small-button" onClick={() => void copy()}>{copied ? <><Check size={14}/> Copied</> : 'Copy text'}</button>
            <button type="button" className="ghost-button small-button" disabled={busy} onClick={() => onOpen(platform, 'post')}><AppWindow size={14}/> Open {name}</button></>;
        }
        return <div className="post-target" key={platform}><BrandMark platform={platform} small/><strong>{name}</strong>{state}</div>;
      })}
    </div>}

    {problems.map((problem) => <div key={problem} className="error-message" role="alert">{problem}</div>)}
    {(error || postError) && <div className="error-message" role="alert">{error || postError}</div>}
    <div className="library-panel-buttons">
      <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
      <button className={automatic ? 'outline-button' : 'primary-button'} disabled={disabled || working || problems.length > 0}>Save</button>
      {automatic && <button type="button" className="primary-button" disabled={disabled || working || problems.length > 0} onClick={() => void approve()}>{working ? <><Loader2 size={15} className="spin"/> Posting…</> : <><Send size={15}/> Post to Instagram</>}</button>}
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

type MakeProps = { brandName: string; brandNotes: string; category: VideoCategory; disabled: boolean; onMake: ReturnType<typeof useVideoGenerations>['make']; onClose: () => void; onManageSources?: () => void };
function MakeVideo({ brandName, brandNotes, category, disabled, onMake, onClose, onManageSources }: MakeProps) {
  const [state, setState] = useState<SourcesState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_RATIO);
  const [duration, setDuration] = useState<number | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingGuard = useRef(false);
  const [error, setError] = useState('');
  const [multiScene, setMultiScene] = useState(false);
  const [ideaNotice, setIdeaNotice] = useState('');
  useEffect(() => { listVideoSources().then(setState).catch((reason) => setLoadError(isTauri() ? errorText(reason, 'Could not load video sources.') : DESKTOP_ONLY)); }, []);

  const usable = state?.sources.filter((source) => source.status !== 'rejected') ?? [];
  const source = usable.find((item) => item.id === sourceId) ?? usable.find((item) => item.id === state?.active) ?? usable[0];
  const provider = source ? PROVIDERS[source.provider] : null;
  const ideas = useVideoIdeas({ brand: brandName, notes: brandNotes, category: category.name, durations: provider?.durations ?? [] });
  useEffect(() => { ideas.reset(); setMultiScene(false); setIdeaNotice(''); }, [source?.id]); // Reset choices when the supported clip lengths change.
  const seconds = provider && duration !== null && provider.durations.includes(duration) ? duration : provider?.defaultDuration ?? 5;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!source || !prompt.trim() || sendingGuard.current || disabled) return;
    sendingGuard.current = true;
    setSending(true); setError('');
    try {
      if (await onMake({ category, brandName, prompt: prompt.trim(), title, sourceId: source.id, aspectRatio, duration: seconds })) {
        if (multiScene) { setPrompt(''); setTitle(''); setIdeaNotice('Clip started. Open the ideas again to choose the next scene.'); }
        else onClose();
      }
    }
    catch (reason) { setError(errorText(reason, 'The video could not be started. Please try again.')); }
    finally { sendingGuard.current = false; setSending(false); }
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
    <button type="button" className="outline-button small-button video-suggest-button" disabled={disabled || sending || ideas.loading !== null} onClick={ideas.start}><Sparkles size={14}/> {ideas.ideas.length ? 'View video ideas' : 'Suggest video prompts'}</button>
    {ideaNotice && <p className="library-hint" role="status">{ideaNotice}</p>}
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
    {ideas.open && <VideoIdeasDialog ideas={ideas.ideas} loading={ideas.loading} error={ideas.error} onSelect={(idea, scene) => { setPrompt(scene.prompt); setTitle(idea.scenes.length > 1 ? `${idea.title}: Scene ${idea.scenes.indexOf(scene) + 1}` : idea.title); setDuration(scene.seconds); setMultiScene(idea.scenes.length > 1); setIdeaNotice(''); ideas.close(); }} onReroll={ideas.reroll} onRerollAll={ideas.rerollAll} onClose={ideas.close}/>}
  </form>;
}
