import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { BookOpen, ChevronDown, ChevronRight, Clapperboard, ImagePlus, Loader2, PenLine, Plus, Sparkles, Trash2, UserRound, Wand2 } from 'lucide-react';
import { getPlatform, type Brand, type Platform, type Series, type SeriesCharacter, type SeriesEpisode, type VideoCategory, type Workspace } from './model';
import { brandSocials } from './VideoLibrary';
import { ASPECT_RATIOS, PROVIDERS } from './videoProviders';
import { DESKTOP_ONLY, listVideoSources, type SourcesState, type VideoSource } from './videoSourcesService';
import { useVideoGenerations } from './useVideoGenerations';
import { generateProfileImage } from './imageAiService';
import { brandImagePreview, keepSquare } from './brandImageService';
import { characterPicturePrompt, continueSeries, planSeries, writeEpisode, type SeriesPlan } from './seriesWriter';
import { isLocalVideo, openVideoFile } from './videoFileService';
import SeriesEpisodeEditor from './SeriesEpisodeEditor';
import { DEFAULT_EPISODES, DEFAULT_SECONDS, episodeCaption, episodeRequest, episodeTitle, episodeVideo, MAX_EPISODES, MAX_STORY_PARTS, MAX_REFERENCE_SECONDS, MIN_EPISODES, nextToPost, partLabel, replaceEpisode, replaceSeries, seriesProgress, withoutSeries } from './series';
import { useConfirm } from './ConfirmDialog';
import { errorText } from './ui';
import './library.css';
import './series.css';

type Save = (next: Workspace, message: string) => Promise<boolean | undefined>;
type Props = { workspace: Workspace; brand: Brand; loaded: boolean; busy: boolean; onSave: Save; onManageSources?: () => void };
const DEFAULT_RATIO = '9:16';

/**
 * The source a series' clips are made with by default: the active source when it is Grok (the base API),
 * else any Grok source, else the active one. Grok keeps characters the same across parts with their pictures.
 */
export function defaultSource(state: SourcesState | null): VideoSource | undefined {
  const usable = state?.sources.filter((source) => source.status !== 'rejected') ?? [];
  const active = usable.find((source) => source.id === state?.active);
  return active?.provider === 'grok' ? active : usable.find((source) => source.provider === 'grok') ?? active ?? usable[0];
}

/** Clip lengths a source offers for a series: with character pictures Grok makes at most 10 seconds. */
export function seriesDurations(source: VideoSource | undefined): number[] {
  if (!source) return [DEFAULT_SECONDS];
  const provider = PROVIDERS[source.provider];
  return provider.references ? provider.durations.filter((seconds) => seconds <= MAX_REFERENCE_SECONDS) : provider.durations;
}

function useSources() {
  const [state, setState] = useState<SourcesState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { listVideoSources().then(setState).catch((reason) => setError(isTauri() ? errorText(reason, 'Could not load video sources.') : DESKTOP_ONLY)); }, []);
  return { state, error };
}

/** A brand's series: stories told across several videos, written by Grok and posted in order. */
export default function SeriesPanel({ workspace, brand, loaded, busy, onSave, onManageSources }: Props) {
  const all = (workspace.series ?? []).filter((series) => series.brandId === brand.id).sort((a, b) => b.createdAt - a.createdAt);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const sources = useSources();
  const generations = useVideoGenerations(workspace, onSave);
  const disabled = !loaded || busy;
  const open = all.find((series) => series.id === openId);

  if (open) return <SeriesDetail key={open.id} series={open} workspace={workspace} brand={brand} disabled={disabled} sources={sources.state} sourcesError={sources.error} onSave={onSave} onBack={() => setOpenId(null)} make={generations.make} progress={generations.progress} onManageSources={onManageSources}/>;
  return <section className="series-list" aria-label="Stories">
    <div className="library-head">
      <div><h2>Stories</h2><p>Write a story, build its parts, and keep every generated video together.</p></div>
      <div className="library-actions"><button type="button" className={creating ? 'outline-button' : 'primary-button'} aria-expanded={creating} onClick={() => setCreating(!creating)}><Plus size={15}/> New story</button></div>
    </div>
    {creating && <NewSeries workspace={workspace} brand={brand} disabled={disabled} sources={sources.state} sourcesError={sources.error} onSave={onSave} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} onManageSources={onManageSources}/>}
    {all.length === 0 && !creating ? <div className="card empty-state"><div className="empty-icon"><BookOpen size={22}/></div><strong>No stories yet</strong><p>Start with your idea or let Grok suggest a complete story for this brand.</p><button className="primary-button" onClick={() => setCreating(true)}><Plus size={15}/> New story</button></div>
      : <ul className="series-cards">{all.map((series) => {
        const done = seriesProgress(workspace, series, brandSocials(workspace, brand.id));
        return <li key={series.id}><button type="button" className="card series-card" onClick={() => setOpenId(series.id)}>
          <strong>{series.title}</strong>
          <span>{series.premise}</span>
          <small>{done.total} parts · {done.scripted} scripted · {done.made} made · {done.posted} posted everywhere</small>
          <ChevronRight size={16} className="series-card-go"/>
        </button></li>;
      })}</ul>}
  </section>;
}

type NewProps = { workspace: Workspace; brand: Brand; disabled: boolean; sources: SourcesState | null; sourcesError: string; onSave: Save; onClose: () => void; onCreated: (id: string) => void; onManageSources?: () => void };
function NewSeries({ workspace, brand, disabled, sources, sourcesError, onSave, onClose, onCreated, onManageSources }: NewProps) {
  const categories = (workspace.categories ?? []).filter((category) => category.brandId === brand.id);
  const [premise, setPremise] = useState('');
  const [count, setCount] = useState(DEFAULT_EPISODES);
  const [sourceId, setSourceId] = useState('');
  const [seconds, setSeconds] = useState(DEFAULT_SECONDS);
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_RATIO);
  const [categoryId, setCategoryId] = useState('');
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<SeriesPlan | null>(null);
  const planGuard = useRef(false);
  const [error, setError] = useState('');
  const usable = sources?.sources.filter((source) => source.status !== 'rejected') ?? [];
  const source = usable.find((item) => item.id === sourceId) ?? defaultSource(sources);
  const durations = seriesDurations(source);
  const length = durations.includes(seconds) ? seconds : durations.reduce((best, value) => Math.abs(value - DEFAULT_SECONDS) < Math.abs(best - DEFAULT_SECONDS) ? value : best, durations[0]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (planGuard.current || planning || disabled) return;
    planGuard.current = true;
    setPlanning(true); setError('');
    try {
      const draft = await planSeries({ brandName: brand.name, brandNotes: brand.notes, premise: premise.trim() || `A story inspired by ${brand.name} and its audience`, episodes: count, seconds: length, avoid: plan?.title });
      setPlan(draft);
    } catch (reason) { setError(errorText(reason, 'Grok could not plan the story. Try again.')); }
    finally { planGuard.current = false; setPlanning(false); }
  }

  async function savePlan() {
    if (!plan || planGuard.current || disabled) return;
    planGuard.current = true; setPlanning(true); setError('');
    try {
      const existing = categories.find((category) => category.id === categoryId);
      const category: VideoCategory = existing ?? { id: crypto.randomUUID(), brandId: brand.id, name: plan.title };
      const series: Series = {
        id: crypto.randomUUID(), brandId: brand.id, categoryId: category.id, title: plan.title, premise: premise.trim() || `A story inspired by ${brand.name}`, bible: plan.bible, story: plan.story, style: plan.style,
        characters: plan.characters.map((character) => ({ ...character, id: crypto.randomUUID() })),
        episodes: plan.episodes.map((episode, index) => ({ ...episode, id: crypto.randomUUID(), number: index + 1 })),
        sourceId: source?.id, aspectRatio, duration: length, createdAt: Date.now(),
      };
      const next = replaceSeries(existing ? workspace : { ...workspace, categories: [...(workspace.categories ?? []), category] }, series);
      if (await onSave(next, `Saved "${series.title}" in ${series.episodes.length} parts.`)) onCreated(series.id);
    } catch (reason) { setError(errorText(reason, 'Could not save the story. Try again.')); }
    finally { planGuard.current = false; setPlanning(false); }
  }

  return <form className="card library-panel" onSubmit={(event) => void submit(event)} aria-label="New story">
    <label htmlFor="series-premise">What is the story about?</label>
    <textarea id="series-premise" autoFocus disabled={planning} maxLength={1500} rows={3} value={premise} onChange={(event) => { setPremise(event.target.value); setPlan(null); }} placeholder="Optional: describe a story, or let Grok use your brand."/>
    <div className="library-make-row">
      <div><label htmlFor="series-count">Parts</label>
        <select id="series-count" disabled={planning} value={count} onChange={(event) => { setCount(Number(event.target.value)); setPlan(null); }}>{Array.from({ length: MAX_EPISODES - MIN_EPISODES + 1 }, (_, index) => index + MIN_EPISODES).map((value) => <option key={value} value={value}>{value} videos</option>)}</select></div>
      <div><label htmlFor="series-length">Each part</label>
        <select id="series-length" disabled={planning} value={length} onChange={(event) => { setSeconds(Number(event.target.value)); setPlan(null); }}>{durations.map((value) => <option key={value} value={value}>{value} seconds</option>)}</select></div>
    </div>
    <div className="library-make-row">
      <div><label htmlFor="series-source">Clips made with</label>
        {usable.length ? <select id="series-source" disabled={planning} value={source?.id ?? ''} onChange={(event) => { setSourceId(event.target.value); setPlan(null); }}>{usable.map((item) => <option key={item.id} value={item.id}>{item.name} · {PROVIDERS[item.provider].name}</option>)}</select>
          : <p className="library-hint">{sourcesError || (sources ? 'No video source yet.' : 'Loading video sources…')} {onManageSources && sources && <button type="button" className="library-more" onClick={onManageSources}>Set one up</button>}</p>}</div>
      <div><label htmlFor="series-category">Saved in</label>
        <select id="series-category" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">A new category named after the story</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>
    </div>
    <div className="library-make-row"><div><label htmlFor="series-ratio">Shape</label><select id="series-ratio" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>{ASPECT_RATIOS.map((ratio) => <option key={ratio.value} value={ratio.value}>{ratio.label}</option>)}</select></div></div>
    <p className="library-hint">Grok writes the story. {source && !PROVIDERS[source.provider].references ? `${PROVIDERS[source.provider].name} can't take character pictures, so characters are kept the same by describing them in every clip.` : 'Each character gets a reference picture that goes with every clip, so they look the same in every part.'}</p>
    {plan && <div className="series-plan-preview" aria-label="Story preview"><h3>{plan.title}</h3><p className="series-script">{plan.story}</p><h4>Video parts</h4><ol>{plan.episodes.map((part, index) => <li key={index}><strong>{part.title}</strong> — {part.summary}</li>)}</ol><p className="library-hint">Review this draft, reroll it, or save it to edit the story and parts.</p></div>}
    {error && <div className="error-message" role="alert">{error}</div>}
    <div className="library-panel-buttons"><button type="button" className="ghost-button" disabled={planning} onClick={onClose}>Cancel</button><button className="outline-button" disabled={disabled || planning}>{planning ? <><Loader2 size={15} className="spin"/> Grok is writing…</> : <><Sparkles size={15}/> {plan ? 'Reroll story' : 'Generate story'}</>}</button>{plan && <button type="button" className="primary-button" disabled={disabled || planning} onClick={() => void savePlan()}>Save story</button>}</div>
  </form>;
}

type DetailProps = { series: Series; workspace: Workspace; brand: Brand; disabled: boolean; sources: SourcesState | null; sourcesError: string; onSave: Save; onBack: () => void;
  make: ReturnType<typeof useVideoGenerations>['make']; progress: Record<string, string>; onManageSources?: () => void };

function SeriesDetail({ series, workspace, brand, disabled, sources, sourcesError, onSave, onBack, make, progress, onManageSources }: DetailProps) {
  const latest = useRef(workspace);
  latest.current = workspace;
  const [working, setWorking] = useState<string | null>(null);
  const workingRef = useRef(false);
  const [error, setError] = useState('');
  const [bible, setBible] = useState(series.bible);
  const [storyText, setStoryText] = useState(series.story ?? '');
  const [editingPart, setEditingPart] = useState<string | null>(null);
  const [continuationDirection, setContinuationDirection] = useState('');
  const [showBible, setShowBible] = useState(false);
  const { confirm, dialog } = useConfirm();
  const socials = brandSocials(workspace, brand.id);
  const category = workspace.categories?.find((item) => item.id === series.categoryId);
  const usable = sources?.sources.filter((source) => source.status !== 'rejected') ?? [];
  const source = usable.find((item) => item.id === series.sourceId) ?? defaultSource(sources);
  const provider = source ? PROVIDERS[source.provider] : null;
  const done = seriesProgress(workspace, series, socials);
  const next = nextToPost(workspace, series, socials);
  const busy = disabled || working !== null;
  const unsavedStory = storyText.trim() !== (series.story ?? '');
  /** Saves a change to this series on top of the newest workspace (a clip may have finished meanwhile). */
  const saveSeries = async (change: (current: Series) => Series, message: string) => {
    const before = latest.current;
    const current = before.series?.find((item) => item.id === series.id) ?? series;
    const next = replaceSeries(before, change(current));
    const saved = await onSave(next, message);
    if (saved && latest.current === before) latest.current = next;
    return saved;
  };

  async function run(key: string, task: () => Promise<unknown>, fallback: string) {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(key); setError('');
    try { await task(); } catch (reason) { setError(errorText(reason, fallback)); } finally { workingRef.current = false; setWorking(null); }
  }

  const addPart = () => run('add-part', async () => {
    await saveSeries((current) => ({ ...current, episodes: [...current.episodes, { id: crypto.randomUUID(), number: current.episodes.length + 1, title: `Part ${current.episodes.length + 1}`, summary: 'Describe what happens in this part.' }] }), 'Added a new story part.');
  }, 'Could not add a part.');
  const extend = () => run('extend', async () => {
    const current = latest.current.series?.find((item) => item.id === series.id) ?? series;
    const draft = await continueSeries(current, 1, continuationDirection);
    const combined = [current.story?.trim(), draft.continuation].filter(Boolean).join('\n\n');
    if (combined.length > 12000) throw new Error('The story is too long to extend automatically. Shorten it first.');
    const saved = await saveSeries((value) => ({ ...value, story: combined, episodes: [...value.episodes, ...draft.episodes.map((episode, index) => ({ ...episode, id: crypto.randomUUID(), number: value.episodes.length + index + 1 }))] }), 'Grok continued the story.');
    if (saved) { setStoryText(combined); setContinuationDirection(''); }
  }, 'Grok could not continue this story. Try again.');

  const script = (episode: SeriesEpisode) => run(`script-${episode.id}`, async () => {
    const draft = await writeEpisode(latest.current.series?.find((item) => item.id === series.id) ?? series, episode);
    await saveSeries((current) => replaceEpisode(current, { ...episode, ...draft }), `Grok wrote ${partLabel(episode.number, series.episodes.length)}.`);
  }, 'Grok could not write this part. Try again.');

  const rewriteDraft = async (episode: SeriesEpisode, direction: string) => {
    if (workingRef.current) throw new Error('Another story action is still running.');
    workingRef.current = true; setWorking(`rewrite-${episode.id}`);
    try { return await writeEpisode(latest.current.series?.find((item) => item.id === series.id) ?? series, episode, direction); }
    finally { workingRef.current = false; setWorking(null); }
  };

  const scriptAll = () => run('script-all', async () => {
    for (const episode of [...series.episodes].sort((a, b) => a.number - b.number)) {
      const current = latest.current.series?.find((item) => item.id === series.id) ?? series;
      const now = current.episodes.find((item) => item.id === episode.id) ?? episode;
      if (now.script?.trim()) continue;
      const draft = await writeEpisode(current, now);
      if (!await saveSeries((saved) => replaceEpisode(saved, { ...now, ...draft }), `Grok wrote ${partLabel(episode.number, series.episodes.length)}.`)) throw new Error('Could not save the script. Try the remaining parts again.');
    }
  }, 'Grok stopped partway through. Write the rest again.');

  const makeClip = (episode: SeriesEpisode) => run(`clip-${episode.id}`, async () => {
    if (!source || !provider) throw new Error('Set up a video source first.');
    if (!category) throw new Error('This story has lost its category. Pick one by making the story again.');
    const request = episodeRequest(series, episode, provider.references);
    const duration = provider.references && request.references.length ? Math.min(series.duration, MAX_REFERENCE_SECONDS) : series.duration;
    const seconds = provider.durations.includes(duration) ? duration : provider.defaultDuration;
    await make({ category, brandName: brand.name, prompt: request.prompt, title: episodeTitle(series, episode), sourceId: source.id, aspectRatio: series.aspectRatio, duration: seconds,
      references: request.references, post: { caption: episodeCaption(series, episode), seriesId: series.id, episode: episode.number } });
  }, 'The clip could not be started. Try again.');

  const picture = (character: SeriesCharacter) => run(`pic-${character.id}`, async () => {
    const made = await generateProfileImage({ prompt: characterPicturePrompt(series, character) });
    const file = await keepSquare(made.preview);
    await saveSeries((current) => ({ ...current, characters: current.characters.map((item) => item.id === character.id ? { ...item, imageFile: file } : item) }), `Made a picture of ${character.name}.`);
  }, 'Grok could not make the picture. Try rewording the description.');

  async function remove() {
    if (busy || !await confirm({ title: `Delete the story "${series.title}"?`, body: <p>Its story and scripts are deleted. Videos already made stay in {category?.name ?? 'their category'}.</p>, confirmLabel: 'Delete story' })) return;
    if (await onSave(withoutSeries(latest.current, series.id), `Deleted the story "${series.title}".`)) onBack();
  }

  return <section className="series-detail" aria-label={series.title}>
    <button type="button" className="library-more" onClick={onBack}><ChevronRight size={14} className="flip"/> All stories</button>
    <div className="library-head">
      <div><h2>{series.title}</h2><p>{done.total} parts · {done.scripted} scripted · {done.made} made · {done.posted} posted everywhere · saved in {category?.name ?? 'no category'}</p></div>
      <div className="library-actions">
        <button type="button" className="primary-button" disabled={busy || editingPart !== null || unsavedStory || done.scripted === done.total} title={unsavedStory ? 'Save the story before writing scripts.' : undefined} onClick={() => void scriptAll()}>{working === 'script-all' ? <><Loader2 size={15} className="spin"/> Writing…</> : <><PenLine size={15}/> Write all scripts</>}</button>
        <button type="button" className="icon-button" aria-label="Delete story" title="Delete story" disabled={busy} onClick={() => void remove()}><Trash2 size={15}/></button>
      </div>
    </div>
    {socials.length > 0 && <p className="series-next" role="status">Next to post: {next.map(({ platform, number }) => `${getPlatform(platform).name} ${number ? partLabel(number, done.total) : 'all posted'}`).join(' · ')}</p>}
    <p className="library-hint">{source && provider ? <>Clips are made with {source.name} ({provider.name}). {provider.references ? 'Character pictures go with every clip.' : `${provider.name} can't take character pictures, so characters are described in each clip.`}</> : <>{sourcesError || 'No video source yet.'} {onManageSources && <button type="button" className="library-more" onClick={onManageSources}>Set one up</button>}</>}</p>
    {error && <div className="error-message" role="alert">{error}</div>}

    <div className="card series-section">
      <label htmlFor="series-story" className="series-section-head"><BookOpen size={15}/> Written story</label>
      <p className="library-hint">Edit the complete story here. Each part below has its own script and video prompt.</p>
      <textarea id="series-story" rows={10} disabled={busy} maxLength={12000} value={storyText} onChange={(event) => setStoryText(event.target.value)} placeholder="Write your story here. Older series can be filled in by hand."/>
      <div className="library-panel-buttons"><button type="button" className="outline-button small-button" disabled={busy || storyText.trim() === (series.story ?? '')} onClick={() => void run('save-story', () => saveSeries((current) => ({ ...current, story: storyText.trim() }), 'Saved the story.'), 'Could not save the story.')}>Save story</button></div>
    </div>

    <div className="card series-section">
      <button type="button" className="series-section-head" aria-expanded={showBible} onClick={() => setShowBible(!showBible)}><BookOpen size={15}/> Story bible {showBible ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
      {showBible && <>
        <label htmlFor="series-bible" className="sr-only">Story bible</label>
        <textarea id="series-bible" rows={6} disabled={busy} maxLength={4000} value={bible} onChange={(event) => setBible(event.target.value)}/>
        {series.style && <p className="library-hint">Look: {series.style}</p>}
        <div className="library-panel-buttons"><button type="button" className="outline-button small-button" disabled={busy || bible.trim() === series.bible} onClick={() => void run('save-bible', () => saveSeries((current) => ({ ...current, bible: bible.trim() }), 'Saved the story bible.'), 'Could not save the story bible.')}>Save story bible</button></div>
      </>}
    </div>

    <div className="card series-section" aria-label="Characters">
      <div className="series-section-head"><UserRound size={15}/> Characters</div>
      <ul className="series-characters">{series.characters.map((character) => <li key={character.id}>
        <CharacterPicture file={character.imageFile} name={character.name}/>
        <div><strong>{character.name}</strong><p>{character.description}</p>
          {provider?.references !== false && <button type="button" className="outline-button small-button" disabled={busy} onClick={() => void picture(character)}>{working === `pic-${character.id}` ? <><Loader2 size={14} className="spin"/> Drawing…</> : character.imageFile ? <><Wand2 size={14}/> Make a new picture</> : <><ImagePlus size={14}/> Make reference picture</>}</button>}
        </div>
      </li>)}</ul>
    </div>

    <div className="series-parts-head"><h3>Story parts</h3><div className="library-actions"><button type="button" className="outline-button small-button" disabled={busy || editingPart !== null || series.episodes.length >= MAX_STORY_PARTS || unsavedStory} title={unsavedStory ? 'Save the story before continuing it.' : undefined} onClick={() => void extend()}><Sparkles size={14}/> {working === 'extend' ? 'Writing…' : 'Continue with Grok'}</button><button type="button" className="outline-button small-button" disabled={busy || editingPart !== null || series.episodes.length >= MAX_STORY_PARTS} onClick={() => void addPart()}><Plus size={14}/> Add part</button></div></div>
    <label className="series-continuation">Direction for the next part <span className="library-hint">Optional</span><input value={continuationDirection} disabled={busy} maxLength={500} onChange={(event) => setContinuationDirection(event.target.value)} placeholder="What should happen next?"/></label>
    <ol className="series-episodes" aria-label="Parts">{[...series.episodes].sort((a, b) => a.number - b.number).map((episode) => {
      const video = episodeVideo(workspace, series, episode.number);
      const videos = (workspace.videos ?? []).filter((item) => item.seriesId === series.id && item.episode === episode.number).sort((a, b) => b.createdAt - a.createdAt);
      const state = !video ? null : video.generation ? (video.generation.status === 'failed' ? 'failed' : 'making') : 'made';
      return <li key={episode.id} className="card series-episode">
        <div className="series-episode-head"><span className="series-part">{partLabel(episode.number, series.episodes.length)}</span><strong>{episode.title}</strong></div>
        <p>{episode.summary}</p>
        {episode.script && <details><summary>Script</summary><p className="series-script">{episode.script}</p>{episode.caption && <p className="library-hint">Caption: {episodeCaption(series, episode)}</p>}</details>}
        {editingPart === episode.id && <SeriesEpisodeEditor key={episode.id} episode={episode} disabled={busy || unsavedStory} onSave={(draft) => saveSeries((current) => replaceEpisode(current, draft), `Saved ${partLabel(episode.number, series.episodes.length)}.`)} onRewrite={rewriteDraft} onCancel={() => setEditingPart(null)}/>}
        {video && <p className="vcard-meta">{state === 'making' ? `Being made${progress[video.id] ? ` · ${progress[video.id]}` : ''}. It shows up in ${category?.name ?? 'Posts'} when ready.` : state === 'failed' ? (video.generation?.message || 'The clip could not be made.') : `Made. Posted on ${video.posted.length ? video.posted.map((platform: Platform) => getPlatform(platform).name).join(', ') : 'nothing yet'}; post it from Posts.`}</p>}
        {videos.length > 0 && <div className="series-linked-videos"><strong>Videos for this part</strong><ul>{videos.map((item) => <li key={item.id}><span>{item.title} — {item.generation ? item.generation.status === 'failed' ? 'Failed' : 'Making' : 'Ready'}</span>{!item.generation && isLocalVideo(item.mediaSource) && <button type="button" className="ghost-button small-button" disabled={busy} onClick={() => void run('open-video', () => openVideoFile(item.mediaSource), 'Could not open the video.')}>Open video</button>}</li>)}</ul></div>}
        <div className="library-panel-buttons">
          <button type="button" className="outline-button small-button" disabled={busy || editingPart !== null} onClick={() => setEditingPart(episode.id)}>Edit part</button>
          <button type="button" className="outline-button small-button" disabled={busy || editingPart !== null || unsavedStory} title={unsavedStory ? 'Save the story before writing scripts.' : undefined} onClick={() => void script(episode)}>{working === `script-${episode.id}` ? <><Loader2 size={14} className="spin"/> Writing…</> : <><PenLine size={14}/> {episode.script ? 'Write again' : 'Write script'}</>}</button>
          <button type="button" className="primary-button small-button" disabled={busy || editingPart !== null || !(episode.script?.trim() || episode.videoPrompt?.trim()) || !source || state === 'making'} title={!(episode.script?.trim() || episode.videoPrompt?.trim()) ? 'Write a script or add a video prompt first.' : undefined} onClick={() => void makeClip(episode)}>{working === `clip-${episode.id}` ? <><Loader2 size={14} className="spin"/> Starting…</> : <><Clapperboard size={14}/> {state === 'made' ? 'Make another' : state === 'failed' ? 'Make again' : 'Make clip'}</>}</button>
        </div>
      </li>;
    })}</ol>
    {dialog}
  </section>;
}

function CharacterPicture({ file, name }: { file?: string; name: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    setSrc('');
    if (file) brandImagePreview(file).then((preview) => { if (live) setSrc(preview); }).catch(() => { /* not on this PC yet */ });
    return () => { live = false; };
  }, [file]);
  return src ? <img className="series-character-picture" src={src} alt={`${name}'s reference picture`}/> : <div className="series-character-picture empty" aria-hidden="true"><UserRound size={22}/></div>;
}
