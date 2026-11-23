import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronRight, Link2, Loader2, MessageCircle, RotateCcw, Send, Sparkles, UserPlus, Wand2 } from 'lucide-react';
import { getPlatform, type View, type Workspace } from '../model';
import { BrandMark, errorText } from '../ui';
import { brandToDo, useAllStatuses } from '../brandStatus';
import { useAyrshare } from '../useAyrshare';
import { useResults } from '../useResults';
import { useFillSlots } from '../useFillSlots';
import { useNow } from '../useNow';
import { listModels } from '../assistant/grokClient';
import { dayLabel, failedPosts, postsBetween, timeLabel, weekCounts, type CalendarPost } from '../calendar';
import { dayStart, postingSettings } from '../postQueue';
import { compact, rangeTotals } from '../results';
import { migrateWorkspace } from '../brands';
import '../today.css';

type BrandTab = 'content' | 'series' | 'schedule' | 'results' | 'accounts';
type Props = {
  workspace: Workspace;
  loaded: boolean;
  onNavigate: (view: View, section?: string) => void;
  onOpenBrand: (brandId: string, tab?: BrandTab) => void;
  onNewBrand: () => void;
};

export const STATE_LABEL: Record<CalendarPost['state'], string> = { posted: 'Live', scheduled: 'Scheduled', failed: 'Failed' };

/**
 * Today: what goes out today, what's coming and what needs Nate. Everything comes from Ayrshare (posts,
 * results, comments) and Grok (videos being made); setup steps show only while something is missing.
 */
export default function TodayPage({ workspace: saved, loaded, onNavigate, onOpenBrand, onNewBrand }: Props) {
  const workspace = useMemo(() => { const moved = migrateWorkspace(saved); return { ...saved, brands: moved.brands, accounts: moved.accounts }; }, [saved]);
  const now = useNow();
  const ayrshare = useAyrshare();
  const results = useResults();
  const fill = useFillSlots(workspace, now);
  const all = useAllStatuses(workspace);
  const [grok, setGrok] = useState<boolean | null>(null);
  useEffect(() => { listModels().then((models) => setGrok(models.length > 0)).catch(() => setGrok(false)); }, []);

  const today = dayStart(now);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const going = postsBetween(workspace, today, tomorrow.getTime());
  const left = going.filter((post) => post.state === 'scheduled').length;
  const counts = weekCounts(workspace, now);
  const views = rangeTotals(workspace, results.posts, '7d', now).current.views;
  const failed = failedPosts(workspace);
  const making = (workspace.videos ?? []).filter((video) => video.generation);
  // One item per brand at most, from what Ayrshare has linked; connecting Ayrshare is one step for all of them.
  const attention = workspace.brands.flatMap((brand) => { const todo = brandToDo(all[brand.id] ?? []); return todo ? [{ brand, todo }] : []; });
  const connected = Boolean(ayrshare.status?.connected && ayrshare.status.working !== false);
  const auto = postingSettings(workspace).autoSchedule;
  const brandName = (id: string) => workspace.brands.find((brand) => brand.id === id)?.name ?? '';
  const categoryName = (videoId: string) => { const video = workspace.videos?.find((item) => item.id === videoId); return workspace.categories?.find((item) => item.id === video?.categoryId)?.name; };
  const [retryError, setRetryError] = useState('');

  const setup = [
    ayrshare.status && !connected && { key: 'ayrshare', title: 'Connect Ayrshare', detail: 'Every post and schedule goes out through it.', label: 'Connect', run: () => onNavigate('settings', 'ayrshare') },
    grok === false && { key: 'grok', title: 'Add your xAI key', detail: 'Grok makes the videos and writes captions and replies.', label: 'Add key', run: () => onNavigate('settings', 'grok') },
    loaded && workspace.brands.length === 0 && { key: 'brand', title: 'Make your first brand', detail: 'It gets its own Ayrshare profile; then you link its socials.', label: 'New brand', run: onNewBrand },
  ].filter(Boolean) as { key: string; title: string; detail: string; label: string; run: () => void }[];
  const needs = setup.length + attention.length + failed.length + (results.open.length ? 1 : 0) + making.length;
  const firstBrand = workspace.brands[0];

  return <>
    <div className="page-heading today-heading">
      <div><p className="greeting">{dayLabel(now)}</p><h1>Today</h1>
        <p>{workspace.brands.length === 0 ? 'Start with a brand: it gets an Ayrshare profile, then you link its socials.'
          : `${left ? `${left} ${left === 1 ? 'post goes' : 'posts go'} out later today.` : going.length ? 'Everything for today is out.' : 'Nothing goes out today.'}${fill.videos ? ` ${fill.videos} ${fill.videos === 1 ? 'video is' : 'videos are'} ready to schedule.` : ''}`}</p></div>
      <div className="heading-buttons">
        {firstBrand ? <button className="outline-button" onClick={() => onOpenBrand(firstBrand.id, 'content')}><Wand2 size={16}/> Make videos with Grok</button>
          : <button className="primary-button" disabled={!loaded} onClick={onNewBrand}><UserPlus size={16}/> New brand</button>}
        {connected && fill.plan.length > 0 && <button className="primary-button" disabled={!!fill.progress} onClick={() => void fill.fill()}>
          {fill.progress ? <><Loader2 size={15} className="spin"/> Scheduling {fill.progress.done + 1} of {fill.progress.total}…</> : <><Send size={15}/> Schedule {fill.videos} ready {fill.videos === 1 ? 'video' : 'videos'}</>}</button>}
      </div>
    </div>
    {fill.error && <div className="error-message" role="alert">{fill.error}</div>}

    {workspace.brands.length > 0 && <div className="stat-grid">
      <button type="button" className="stat stat-button" onClick={() => onNavigate('calendar')}><span>Scheduled</span><strong>{counts.scheduled}</strong><small>Next 7 days{auto ? ', more added by itself' : ''}</small></button>
      <div className="stat"><span>Posted this week</span><strong>{counts.posted}</strong><small>Across every social</small></div>
      <button type="button" className="stat stat-button" onClick={() => onNavigate('results')}><span>Views</span><strong>{compact(views)}</strong><small>Posts of the last 7 days</small></button>
      <button type="button" className="stat stat-button" onClick={() => onNavigate('comments')}><span>New comments</span><strong>{results.open.length}</strong><small>{results.open.length ? 'To answer' : 'All answered'}</small></button>
    </div>}

    <div className="overview-grid">
      <section className="card" aria-label="Going out today">
        <div className="card-title"><div><h2>Going out today</h2><p>{going.length ? `${going.length} ${going.length === 1 ? 'post' : 'posts'}` : 'Nothing today'}</p></div>
          <button className="text-button" onClick={() => onNavigate('calendar')}>Open calendar <ChevronRight size={15}/></button></div>
        {going.length === 0 ? <p className="library-hint">{fill.plan.length ? 'Schedule the ready videos and they fill the open times.' : 'Make videos in a brand and they line up here.'}</p>
          : <ul className="today-list">{going.map((post) => <li key={post.key} className={`today-post state-${post.state}`}>
            <time>{timeLabel(post.at)}</time>
            <div className="today-post-text"><strong>{post.title}</strong><small>{[brandName(post.brandId), categoryName(post.videoId)].filter(Boolean).join(' · ')}</small></div>
            <span className="today-socials">{post.platforms.map((platform) => <BrandMark key={platform} platform={platform} small/>)}</span>
            <span className={`status-chip state-${post.state}`}><span className="dot"/>{STATE_LABEL[post.state]}</span>
          </li>)}</ul>}
      </section>

      <section className="card" aria-label="Needs you">
        <div className="card-title"><div><h2>Needs you</h2><p>{needs ? `${needs} ${needs === 1 ? 'thing' : 'things'}` : 'Nothing right now'}</p></div></div>
        {retryError && <div className="error-message" role="alert">{retryError}</div>}
        {needs === 0 ? <p className="library-hint">Everything is linked, scheduled and answered.</p> : <div className="quick-actions">
          {setup.map((step) => <button key={step.key} className="quick-action attention tone-todo" onClick={step.run}><Sparkles size={18}/><div><strong>{step.title}</strong><small>{step.detail}</small></div><span className="status-chip"><span className="dot"/>{step.label}</span></button>)}
          {attention.map(({ brand, todo }) => <button key={brand.id} className={`quick-action attention tone-${todo.kind === 'relink' ? 'problem' : 'todo'}`} onClick={() => { setRetryError(''); if (todo.kind === 'x-keys') onNavigate('settings', 'ayrshare'); else if (todo.kind === 'setup') onOpenBrand(brand.id, 'accounts'); else ayrshare.link(brand).catch((reason) => setRetryError(errorText(reason))); }}>
            {todo.platforms.length === 1 ? <BrandMark platform={todo.platforms[0]} small/> : <Link2 size={18}/>}<div><strong>{todo.label} · {brand.name}</strong><small>{todo.detail}</small></div>
            <span className="status-chip"><span className="dot"/>{todo.kind === 'setup' ? 'Set up' : todo.kind === 'x-keys' ? 'Add keys' : 'Link'}</span></button>)}
          {failed.slice(0, 5).map((item) => <div key={`${item.video.id}:${item.platform}`} className="quick-action attention tone-problem">
            <BrandMark platform={item.platform} small/><div><strong>{item.video.title} didn't post on {getPlatform(item.platform).name}</strong><small>{item.error ?? 'Ayrshare could not post it.'}</small></div>
            <button type="button" className="outline-button small-button" onClick={() => { setRetryError(''); ayrshare.retry(item.video.id, item.platform).catch((reason) => setRetryError(String(reason instanceof Error ? reason.message : reason))); }}><RotateCcw size={13}/> Retry</button></div>)}
          {results.open.length > 0 && <button className="quick-action" onClick={() => onNavigate('comments')}><MessageCircle size={18}/><div><strong>{results.open.length} {results.open.length === 1 ? 'comment' : 'comments'} to answer</strong><small>Grok drafts each reply; you check and send.</small></div><ChevronRight size={16}/></button>}
          {making.map((video) => <button key={video.id} className="quick-action" onClick={() => onOpenBrand(video.brandId, 'content')}><Wand2 size={18}/>
            <div><strong>{video.generation?.status === 'failed' ? `${video.title} could not be made` : `Grok is making ${video.title}`}</strong><small>{video.generation?.status === 'failed' ? video.generation.message ?? 'Try again from the brand.' : `${brandName(video.brandId)} · ${video.generation?.sourceName ?? 'Grok'}`}</small></div>
            {video.generation?.status === 'working' ? <Loader2 size={16} className="spin"/> : <ChevronRight size={16}/>}</button>)}
        </div>}
        {workspace.brands.length > 0 && <button className="text-button" onClick={() => onNavigate('calendar')}><CalendarDays size={15}/> See the whole week</button>}
      </section>
    </div>
  </>;
}
