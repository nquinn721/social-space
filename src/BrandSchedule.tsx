import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Plus, RotateCcw, X } from 'lucide-react';
import { getPlatform, type Brand, type Platform, type Workspace } from './model';
import { BrandMark } from './ui';
import { brandLanes, DAILY_LIMIT, isTime, notReady, whenLabel, type QueueLane } from './postQueue';
import { useBrandStatuses } from './brandStatus';
import { errorText } from './ui';
import { useNow } from './useNow';
import { videoPartLabel } from './series';
import { useAyrshare } from './useAyrshare';
import './queue.css';

/** The day's posting times (up to DAILY_LIMIT), edited in place and saved together. */
export function PostingTimes({ times, disabled, onSave }: { times: string[]; disabled: boolean; onSave: (times: string[]) => void }) {
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
export function BrandQueue({ brand, lanes, workspace, now, onOpenBrand, inBrand, ...actions }: { brand: Brand; lanes: QueueLane[]; workspace: Workspace; now: number; onOpenBrand: (brandId: string, tab?: 'content' | 'accounts') => void; /** On the brand's own page: no title or Open button. */ inBrand?: boolean } & LaneActions) {
  const unready = notReady(workspace, brand.id);
  const making = unready.filter((video) => video.generation).length;
  const fixing = unready.length - making;
  return <section className="card queue-brand" aria-label={`${brand.name} queue`}>
    <div className="card-title queue-brand-head">
      <div><h2>{inBrand ? 'Each social' : brand.name}</h2>{unready.length > 0 && <p>{[making && `${making} being made`, fixing && `${fixing} need${fixing === 1 ? 's' : ''} a file or post details first`].filter(Boolean).join(' · ')}</p>}</div>
      {!inBrand && <button type="button" className="ghost-button small-button" onClick={() => onOpenBrand(brand.id)}>Open videos</button>}
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

/** A brand's Schedule tab: what is scheduled, failed and waiting on each of its socials. */
export default function BrandSchedule({ workspace, brand, onOpenBrand }: { workspace: Workspace; brand: Brand; onOpenBrand: (brandId: string, tab?: 'content' | 'accounts') => void }) {
  const now = useNow();
  const ayrshare = useAyrshare();
  const statuses = useBrandStatuses(workspace, brand.id);
  const lanes = useMemo(() => brandLanes(workspace, brand.id, statuses, now), [workspace, brand.id, statuses, now]);
  const [error, setError] = useState('');
  const act = (action: () => Promise<void>) => { setError(''); action().catch((reason) => setError(errorText(reason))); };
  return <>
    {error && <div className="error-message" role="alert">{error}</div>}
    <BrandQueue brand={brand} lanes={lanes} workspace={workspace} now={now} inBrand onOpenBrand={onOpenBrand}
      onCancel={(videoId, platform) => act(() => ayrshare.cancel(videoId, platform))} onRetry={(videoId, platform) => act(() => ayrshare.retry(videoId, platform))}/>
  </>;
}
