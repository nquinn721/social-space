import { useMemo, useState, type CSSProperties } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, ExternalLink, Loader2, RotateCcw, Send, Settings2, X } from 'lucide-react';
import { getPlatform, type PostingSettings, type Workspace } from '../model';
import { BrandMark, errorText, PageHeader } from '../ui';
import { useAyrshare } from '../useAyrshare';
import { useFillSlots } from '../useFillSlots';
import { useNow } from '../useNow';
import { PostingTimes } from '../BrandSchedule';
import { DAILY_LIMIT, dayStart, postingSettings } from '../postQueue';
import { atTime, failedPosts, openSlots, postsBetween, shortDay, timeLabel, weekDays, weekStart, type CalendarPost } from '../calendar';
import { openPostLink } from '../ayrshareService';
import { STATE_LABEL } from './TodayPage';
import '../today.css';
import '../queue.css';

const BRAND_COLORS = ['var(--pink)', 'var(--violet)', 'var(--cyan)', 'var(--lime)', 'var(--amber)', 'var(--success)'];
export const brandColor = (workspace: Workspace, brandId: string) => BRAND_COLORS[Math.max(0, workspace.brands.findIndex((brand) => brand.id === brandId)) % BRAND_COLORS.length];

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
  onSave: (next: Workspace, message: string) => Promise<boolean | undefined>;
  onOpenBrand: (brandId: string, tab?: 'content' | 'accounts') => void;
  onOpenSettings: () => void;
};

const toInput = (at: number) => { const date = new Date(at); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };

/**
 * Everything Ayrshare will post, a week at a time. Ready videos fill the open posting times (at most 3 a day
 * on a social), by themselves while automatic scheduling is on or with Fill open slots. A post can be moved
 * to another time or unscheduled.
 */
export default function CalendarPage({ workspace, loaded, busy, onSave, onOpenBrand, onOpenSettings }: Props) {
  const now = useNow();
  const ayrshare = useAyrshare();
  const [brandId, setBrandId] = useState('');
  const [start, setStart] = useState(() => weekStart(Date.now()));
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const fill = useFillSlots(workspace, now, brandId || undefined);
  const settings = postingSettings(workspace);
  const connected = Boolean(ayrshare.status?.connected && ayrshare.status.working !== false);
  const days = weekDays(start);
  const end = useMemo(() => { const day = new Date(start); day.setDate(day.getDate() + 7); return day.getTime(); }, [start]);
  const posts = useMemo(() => postsBetween(workspace, start, end, brandId || undefined), [workspace, start, end, brandId]);
  const failed = failedPosts(workspace, brandId || undefined);
  const today = dayStart(now);
  const chosen = posts.find((post) => post.key === selected) ?? null;
  const shownBrands = workspace.brands.filter((brand) => !brandId || brand.id === brandId);

  async function saveSettings(next: PostingSettings, message: string) { setError(''); await onSave({ ...workspace, posting: next }, message); }
  async function run(action: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  const unschedule = (post: CalendarPost) => run(async () => { for (const platform of post.platforms) await ayrshare.cancel(post.videoId, platform); setSelected(null); });
  /** Ayrshare can't move a post, so it is cancelled and scheduled again at the new time. */
  const move = (post: CalendarPost, at: number) => run(async () => {
    if (!Number.isFinite(at) || at < Date.now() + 10 * 60_000) throw new Error('Pick a time at least 10 minutes from now.');
    for (const platform of post.platforms) {
      await ayrshare.cancel(post.videoId, platform);
      const result = await ayrshare.send(post.videoId, platform, at);
      if (result.post.state === 'failed') throw new Error(`${getPlatform(platform).name}: ${result.post.error ?? 'Ayrshare did not take the post.'}`);
    }
    setSelected(null);
  });

  const week = `${new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(end - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  const autoLine = !connected ? 'Ayrshare isn\'t connected, so nothing is scheduled.'
    : !settings.autoSchedule ? 'Automatic scheduling is off: use Fill open slots.'
    : ayrshare.auto.paused ? ayrshare.auto.paused
    : ayrshare.auto.running ? `Scheduling${ayrshare.auto.current ? ` "${ayrshare.auto.current}"` : ''}…`
    : 'Ready videos fill open times by themselves.';

  return <>
    <PageHeader eyebrow="Posting" title="Calendar" description={`Everything Ayrshare will post. Ready videos fill the open slots, up to ${DAILY_LIMIT} a day per social.`}
      actions={<>
        <label className="sr-only" htmlFor="calendar-brand">Brand</label>
        <select id="calendar-brand" value={brandId} onChange={(event) => { setBrandId(event.target.value); setSelected(null); }}><option value="">All brands</option>{workspace.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select>
        <button type="button" className="outline-button" aria-expanded={showSettings} onClick={() => setShowSettings((value) => !value)}><CalendarClock size={15}/> Posting times</button>
        {connected ? <button type="button" className="primary-button" disabled={!loaded || busy || !!fill.progress || fill.plan.length === 0} onClick={() => void fill.fill()}>
          {fill.progress ? <><Loader2 size={15} className="spin"/> Scheduling {fill.progress.done + 1} of {fill.progress.total}…</> : <><Send size={15}/> {fill.plan.length ? `Fill open slots (${fill.plan.length})` : 'No ready videos'}</>}</button>
          : <button type="button" className="primary-button" onClick={onOpenSettings}><Settings2 size={15}/> Connect Ayrshare</button>}
      </>}/>

    {showSettings && <section className="card queue-settings calendar-settings" aria-label="Posting times">
      <div className={`status-line ${connected && !ayrshare.auto.paused ? '' : 'off'}`}><span className="dot"/><span>{ayrshare.auto.running && <Loader2 size={13} className="spin"/>} {autoLine}</span></div>
      <div className="queue-settings-row">
        <label className="toggle-row"><input type="checkbox" checked={settings.autoSchedule} disabled={!loaded || busy} onChange={(event) => void saveSettings({ ...settings, autoSchedule: event.target.checked }, event.target.checked ? 'Automatic scheduling is on.' : 'Automatic scheduling is off.')}/> Schedule new videos by themselves</label>
        <PostingTimes times={settings.times} disabled={!loaded || busy} onSave={(times) => void saveSettings({ ...settings, times }, 'Posting times saved. New posts use them.')}/>
      </div>
      <p className="footnote">Times are this PC's time. Posts already scheduled keep their time.</p>
    </section>}
    {(error || fill.error) && <div className="error-message" role="alert">{error || fill.error}</div>}

    {failed.length > 0 && <section className="card" aria-label="Failed posts">
      <div className="card-title"><div><h2>Didn't post</h2><p>Retry puts them back in the queue.</p></div></div>
      <ul className="failed-list">{failed.slice(0, 8).map((item) => <li key={`${item.video.id}:${item.platform}`} className="today-post state-failed">
        <time>{shortDay(item.at)}</time>
        <div className="today-post-text"><strong>{item.video.title}</strong><small className="danger-text">{item.error ?? 'Ayrshare could not post it.'}</small></div>
        <span className="today-socials"><BrandMark platform={item.platform} small/></span>
        <button type="button" className="outline-button small-button" disabled={working} onClick={() => void run(() => ayrshare.retry(item.video.id, item.platform))}><RotateCcw size={13}/> Retry</button>
      </li>)}</ul>
    </section>}

    <div className="calendar-bar">
      <button type="button" className="icon-button" aria-label="Previous week" onClick={() => { const day = new Date(start); day.setDate(day.getDate() - 7); setStart(day.getTime()); }}><ChevronLeft size={16}/></button>
      <span className="week-label">{week}</span>
      <button type="button" className="icon-button" aria-label="Next week" onClick={() => setStart(end)}><ChevronRight size={16}/></button>
      {start !== weekStart(now) && <button type="button" className="ghost-button small-button" onClick={() => setStart(weekStart(now))}>This week</button>}
      <span className="spacer"/>
      <div className="calendar-legend">{shownBrands.map((brand) => <span key={brand.id} style={{ '--brand-color': brandColor(workspace, brand.id) } as CSSProperties}>{brand.name}</span>)}</div>
    </div>

    <div className="calendar-grid" role="list" aria-label="Week">
      {days.map((day) => {
        const next = new Date(day); next.setDate(next.getDate() + 1);
        const items = posts.filter((post) => post.at >= day && post.at < next.getTime());
        const open = connected && workspace.brands.length > 0 ? openSlots(workspace, day, items, now) : [];
        const entries = [...items.map((post) => ({ at: post.at, post })), ...open.map((at) => ({ at, post: null }))].sort((a, b) => a.at - b.at);
        return <div role="listitem" key={day} className={`calendar-day ${day === today ? 'today' : ''} ${day < today ? 'past' : ''}`} aria-label={new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}>
          <h3>{day === today ? 'Today' : shortDay(day)}</h3>
          {entries.map(({ at, post }) => post
            ? <button type="button" key={post.key} className={`calendar-post state-${post.state} ${selected === post.key ? 'selected' : ''}`} style={{ '--brand-color': brandColor(workspace, post.brandId) } as CSSProperties}
              aria-label={`${post.title}, ${timeLabel(post.at)}, ${STATE_LABEL[post.state]}`} onClick={() => setSelected(selected === post.key ? null : post.key)}>
              <time>{timeLabel(post.at)}{post.state !== 'scheduled' ? ` · ${STATE_LABEL[post.state]}` : ''}</time><strong>{post.title}</strong>
              <span className="today-socials">{post.platforms.map((platform) => <BrandMark key={platform} platform={platform} small/>)}</span>
            </button>
            : <div key={`open-${at}`} className="calendar-open">{timeLabel(at)} · open</div>)}
        </div>;
      })}
    </div>
    {posts.length === 0 && <p className="library-hint">Nothing this week{fill.plan.length ? '. Fill open slots schedules the ready videos.' : '.'}</p>}

    {chosen && <PostDetail key={chosen.key} post={chosen} workspace={workspace} working={working} onClose={() => setSelected(null)} onOpenBrand={onOpenBrand} onUnschedule={() => void unschedule(chosen)} onMove={(at) => void move(chosen, at)}/>}
  </>;
}

function PostDetail({ post, workspace, working, onClose, onOpenBrand, onUnschedule, onMove }: { post: CalendarPost; workspace: Workspace; working: boolean; onClose: () => void; onOpenBrand: Props['onOpenBrand']; onUnschedule: () => void; onMove: (at: number) => void }) {
  const video = workspace.videos?.find((item) => item.id === post.videoId);
  const brand = workspace.brands.find((item) => item.id === post.brandId);
  const [when, setWhen] = useState(toInput(post.at));
  const times = postingSettings(workspace).times;
  return <section className="card calendar-detail" aria-label={`${post.title} details`}>
    <div className="card-title"><div><h2>{post.title}</h2><p>{brand?.name} · {new Date(post.at).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })} · {STATE_LABEL[post.state]}</p></div>
      <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16}/></button></div>
    {video?.caption && <p className="footnote">{video.caption}</p>}
    <div className="detail-row">{post.platforms.map((platform) => { const link = video?.links?.[platform]; return <span key={platform} className="status-chip"><BrandMark platform={platform} small/> {getPlatform(platform).name}
      {post.state === 'posted' && link && <button type="button" className="ghost-button small-button" onClick={() => void openPostLink(link)}><ExternalLink size={12}/> View</button>}</span>; })}</div>
    {post.state === 'scheduled' && <div className="detail-row">
      <label htmlFor="move-to">Move to</label>
      <input id="move-to" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)}/>
      {times.map((time) => { const at = atTime(new Date(when).getTime(), time); return Number.isFinite(at) ? <button key={time} type="button" className="ghost-button small-button" onClick={() => setWhen(toInput(at))}>{time}</button> : null; })}
      <button type="button" className="primary-button small-button" disabled={working || toInput(post.at) === when} onClick={() => onMove(new Date(when).getTime())}>{working ? <Loader2 size={13} className="spin"/> : null} Move</button>
      <button type="button" className="remove-button" disabled={working} onClick={onUnschedule}><X size={13}/> Unschedule</button>
    </div>}
    <div className="detail-row"><button type="button" className="text-button" onClick={() => onOpenBrand(post.brandId, 'content')}>Edit caption and details in {brand?.name ?? 'the brand'} <ChevronRight size={14}/></button></div>
  </section>;
}
