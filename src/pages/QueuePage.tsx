import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, ListOrdered, Loader2, Plus, RotateCcw, Send, X } from 'lucide-react';
import { getPlatform, type Brand, type Platform, type PostingSettings, type Workspace } from '../model';
import { BrandMark, errorText, PageHeader } from '../ui';
import { useAllStatuses } from '../brandStatus';
import { brandLanes, DAILY_LIMIT, isTime, notReady, planSchedule, postingSettings, whenLabel, type QueueLane } from '../postQueue';
import { videoPartLabel } from '../series';
import { useAyrshare } from '../useAyrshare';
import '../library.css';
import '../series.css';
import '../queue.css';

type Props = {
  workspace: Workspace;
  loaded: boolean;
  busy: boolean;
  onSave: (next: Workspace, message: string) => Promise<boolean | undefined>;
  /** Opens a brand's page on its posts, to make videos or fix a social. */
  onOpenBrand: (brandId: string, tab?: 'content' | 'accounts') => void;
  /** Goes to Settings → Posting, to connect Ayrshare. */
  onOpenSettings?: () => void;
};

/** The time, moved on every minute, so a new day frees the daily limits without a reload. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  return now;
}

/**
 * The post queue: each brand's finished videos wait their turn on every social, oldest first, and go to
 * Ayrshare scheduled into the next free posting time (at most DAILY_LIMIT a day on an account). With
 * automatic scheduling on, the app does that by itself while it is open; Ayrshare posts them on time even
 * when the app is closed. What this page shows comes from the workspace, whose post states Ayrshare reports.
 */
export default function QueuePage({ workspace, loaded, busy, onSave, onOpenBrand, onOpenSettings }: Props) {
  const now = useNow();
  const ayrshare = useAyrshare();
  const all = useAllStatuses(workspace);
  const lanesByBrand = useMemo(() => workspace.brands.map((brand) => ({ brand, lanes: brandLanes(workspace, brand.id, all[brand.id] ?? [], now) })), [workspace, all, now]);
  const settings = postingSettings(workspace);
  const [error, setError] = useState('');
  const [manual, setManual] = useState<{ done: number; total: number } | null>(null);
  const connected = Boolean(ayrshare.status?.connected && ayrshare.status.working !== false);
  const disabled = !loaded || busy;

  const lanes = lanesByBrand.flatMap((item) => item.lanes);
  const waitingTotal = lanes.reduce((sum, lane) => sum + lane.waiting.length, 0);
  const scheduledTotal = lanes.reduce((sum, lane) => sum + lane.scheduled.length, 0);
  const failedTotal = lanes.reduce((sum, lane) => sum + lane.failed.length, 0);
  const plan = useMemo(() => lanesByBrand.flatMap(({ brand, lanes }) => planSchedule(workspace, brand.id, lanes.filter((lane) => lane.status.canPost).map((lane) => lane.platform), now)), [lanesByBrand, workspace, now]);

  async function saveSettings(next: PostingSettings, message: string) {
    setError('');
    await onSave({ ...workspace, posting: next }, message);
  }
  /** With automatic scheduling off: schedules everything that fits in the next three weeks, one post at a time. */
  async function scheduleNow() {
    if (manual) return;
    setError('');
    setManual({ done: 0, total: plan.length });
    try {
      for (const [index, item] of plan.entries()) {
        const result = await ayrshare.send(item.videoId, item.platform, item.at);
        if (result.post.state === 'failed') throw new Error(result.post.error ?? 'Ayrshare did not take the post.');
        setManual({ done: index + 1, total: plan.length });
      }
    } catch (reason) { setError(errorText(reason, 'Could not schedule the posts.')); }
    finally { setManual(null); }
  }
  async function act(action: () => Promise<void>) {
    setError('');
    try { await action(); } catch (reason) { setError(errorText(reason)); }
  }

  const autoLine = !connected ? 'Ayrshare isn\'t connected, so nothing is scheduled.'
    : !settings.autoSchedule ? `Automatic scheduling is off.${plan.length ? ` ${plan.length} ${plan.length === 1 ? 'post is' : 'posts are'} ready to schedule.` : ''}`
    : ayrshare.auto.paused ? ayrshare.auto.paused
    : ayrshare.auto.running ? `Scheduling${ayrshare.auto.current ? ` "${ayrshare.auto.current}"` : ''}…`
    : plan.length ? 'Scheduling the next posts…'
    : waitingTotal ? 'Everything that fits in the next three weeks is scheduled. The rest follows as days open up.'
    : 'Everything is scheduled.';

  return <>
    <PageHeader eyebrow="Posting" title="Post queue" description={<>Every finished video waits its turn, oldest first, on each social of its brand, and goes to Ayrshare scheduled into the next posting time: at most {DAILY_LIMIT} a day on an account. Ayrshare posts them on time, even with the app closed.</>}
      actions={connected && !settings.autoSchedule && <button type="button" className="primary-button" disabled={disabled || !!manual || plan.length === 0} onClick={() => void scheduleNow()}>{manual ? <><Loader2 size={15} className="spin"/> Scheduling {manual.done + 1} of {manual.total}…</> : <><Send size={15}/> {plan.length ? `Schedule ${plan.length} ${plan.length === 1 ? 'post' : 'posts'}` : 'Nothing to schedule'}</>}</button>}/>

    <section className="card queue-settings" aria-label="Scheduling">
      <div className={`status-line ${connected && !ayrshare.auto.paused ? '' : 'off'}`}><span className="dot"/><span>{ayrshare.auto.running && <Loader2 size={13} className="spin"/>} {autoLine}</span>
        {!connected && onOpenSettings && <button type="button" className="primary-button small-button" onClick={onOpenSettings}>Connect Ayrshare</button>}
      </div>
      <div className="queue-settings-row">
        <label className="toggle-row"><input type="checkbox" checked={settings.autoSchedule} disabled={disabled} onChange={(event) => void saveSettings({ ...settings, autoSchedule: event.target.checked }, event.target.checked ? 'Automatic scheduling is on.' : 'Automatic scheduling is off.')}/> Schedule new videos by themselves</label>
        <PostingTimes times={settings.times} disabled={disabled} onSave={(times) => void saveSettings({ ...settings, times }, 'Posting times saved. New posts use them.')}/>
      </div>
      <p className="footnote">{scheduledTotal} scheduled · {waitingTotal} waiting{failedTotal ? ` · ${failedTotal} failed` : ''}. Times are this PC's time. Posts already scheduled keep their time.</p>
    </section>
    {error && <div className="error-message" role="alert">{error}</div>}

    {workspace.brands.length === 0 ? <section className="card empty-state"><div className="empty-icon"><ListOrdered size={22}/></div><strong>No brands yet</strong><p>Create a brand and make some videos. They line up here.</p></section>
      : waitingTotal + scheduledTotal + failedTotal === 0 && <p className="library-hint">Nothing is waiting. Make videos in a brand's Posts tab and they line up here.</p>}

    {lanesByBrand.map(({ brand, lanes }) => <BrandQueue key={brand.id} brand={brand} lanes={lanes} workspace={workspace} now={now}
      onOpenBrand={onOpenBrand} onCancel={(videoId, platform) => void act(() => ayrshare.cancel(videoId, platform))} onRetry={(videoId, platform) => void act(() => ayrshare.retry(videoId, platform))}/>)}
  </>;
}

/** The day's posting times (up to DAILY_LIMIT), edited in place and saved together. */
function PostingTimes({ times, disabled, onSave }: { times: string[]; disabled: boolean; onSave: (times: string[]) => void }) {
  const [draft, setDraft] = useState(times);
  const saved = times.join(',');
  useEffect(() => setDraft(times), [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = draft.length > 0 && draft.every(isTime) && new Set(draft).size === draft.length;
  const changed = [...draft].sort().join(',') !== saved;
  return <div className="posting-times" aria-label="Posting times">
    <CalendarClock size={15}/><span>Posts go out at</span>
    {draft.map((time, index) => <span key={index} className="posting-time">
      <input type="time" aria-label={`Posting time ${index + 1}`} value={time} disabled={disabled} onChange={(event) => setDraft(draft.map((item, at) => at === index ? event.target.value : item))}/>
      {draft.length > 1 && <button type="button" className="icon-button" aria-label={`Remove ${time}`} disabled={disabled} onClick={() => setDraft(draft.filter((_, at) => at !== index))}><X size={12}/></button>}
    </span>)}
    {draft.length < DAILY_LIMIT && <button type="button" className="ghost-button small-button" disabled={disabled} onClick={() => setDraft([...draft, '20:00'].filter((item, at, list) => list.indexOf(item) === at))}><Plus size={13}/> Add a time</button>}
    {changed && <button type="button" className="outline-button small-button" disabled={disabled || !valid} onClick={() => onSave([...draft].sort())}>Save times</button>}
  </div>;
}

type LaneActions = { onCancel: (videoId: string, platform: Platform) => void; onRetry: (videoId: string, platform: Platform) => void };

/** One brand's socials: what is scheduled when, what failed, and what still waits. */
function BrandQueue({ brand, lanes, workspace, now, onOpenBrand, ...actions }: { brand: Brand; lanes: QueueLane[]; workspace: Workspace; now: number; onOpenBrand: Props['onOpenBrand'] } & LaneActions) {
  const unready = notReady(workspace, brand.id);
  const making = unready.filter((video) => video.generation).length;
  const fixing = unready.length - making;
  return <section className="card queue-brand" aria-label={`${brand.name} queue`}>
    <div className="card-title queue-brand-head">
      <div><h2>{brand.name}</h2>{unready.length > 0 && <p>{[making && `${making} being made`, fixing && `${fixing} need${fixing === 1 ? 's' : ''} a file or post details first`].filter(Boolean).join(' · ')}</p>}</div>
      <button type="button" className="ghost-button small-button" onClick={() => onOpenBrand(brand.id)}>Open posts</button>
    </div>
    {lanes.length === 0 ? <p className="library-hint">{brand.name} has no social profiles yet.</p> : <ul className="queue-lanes">
      {lanes.map((lane) => <Lane key={lane.platform} lane={lane} workspace={workspace} now={now} onFix={() => onOpenBrand(brand.id, 'accounts')} {...actions}/>)}
    </ul>}
  </section>;
}

function Lane({ lane, workspace, now, onFix, onCancel, onRetry }: { lane: QueueLane; workspace: Workspace; now: number; onFix: () => void } & LaneActions) {
  const ayrshare = useAyrshare();
  const name = getPlatform(lane.platform).name;
  const part = (id: string) => { const video = workspace.videos?.find((item) => item.id === id); return video ? videoPartLabel(workspace, video) : null; };
  const summary = !lane.status.canPost ? lane.status.label
    : [lane.scheduled.length && `${lane.scheduled.length} scheduled`, lane.waiting.length && `${lane.waiting.length} waiting`].filter(Boolean).join(' · ') || 'Nothing waiting';
  return <li className={`queue-lane tone-${lane.status.canPost ? (lane.failed.length ? 'problem' : 'ok') : lane.status.tone}`}>
    <BrandMark platform={lane.platform} small/>
    <div className="queue-lane-name"><strong>{name}</strong><small>{summary}</small></div>
    <div className="queue-pips" aria-label={`${lane.today} of ${DAILY_LIMIT} today`} title="Posts today, up or scheduled">
      {Array.from({ length: DAILY_LIMIT }, (_, index) => <span key={index} className={index < lane.today ? 'filled' : ''}/>)}
      <small>{lane.today}/{DAILY_LIMIT} today</small>
    </div>
    <div className="queue-next">
      {!lane.status.canPost && <><small>{lane.status.detail}</small>{lane.status.action && <button type="button" className="dest-button" onClick={onFix}>{lane.status.action.short}</button>}</>}
      {(lane.scheduled.length > 0 || lane.failed.length > 0) && <ol className="queue-posts">
        {lane.failed.map((video) => <li key={video.id} className="failed" title={video.scheduled?.[lane.platform]?.error}>
          {part(video.id) && <span className="series-badge">{part(video.id)}</span>}<span className="queue-post-title">{video.title}</span>
          <small className="danger-text">Failed: {video.scheduled?.[lane.platform]?.error ?? 'Ayrshare could not post it.'}</small>
          <button type="button" className="ghost-button small-button" onClick={() => onRetry(video.id, lane.platform)}><RotateCcw size={12}/> Retry</button>
        </li>)}
        {lane.scheduled.slice(0, DAILY_LIMIT * 2).map((video) => <li key={video.id}>
          {part(video.id) && <span className="series-badge">{part(video.id)}</span>}<span className="queue-post-title">{video.title}</span>
          <small>{whenLabel(video.scheduled![lane.platform]!.at, now)}</small>
          <button type="button" className="ghost-button small-button" aria-label={`Cancel ${video.title} on ${name}`} disabled={ayrshare.isSending(video.id, lane.platform)} onClick={() => onCancel(video.id, lane.platform)}><X size={12}/> Cancel</button>
        </li>)}
        {lane.scheduled.length > DAILY_LIMIT * 2 && <li className="more"><small>and {lane.scheduled.length - DAILY_LIMIT * 2} more scheduled, the last {whenLabel(lane.scheduled[lane.scheduled.length - 1].scheduled![lane.platform]!.at, now)}</small></li>}
      </ol>}
      {lane.status.canPost && lane.waiting.length > 0 && <small>{lane.waiting.length} waiting{lane.lastAt !== null ? `, all out by ${whenLabel(lane.lastAt, now)}` : ''}</small>}
      {lane.status.canPost && lane.scheduled.length === 0 && lane.failed.length === 0 && lane.waiting.length === 0 && <small>Nothing waiting.</small>}
    </div>
  </li>;
}
