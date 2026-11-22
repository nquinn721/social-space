import { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Check, ListOrdered, Play, SkipForward, Square } from 'lucide-react';
import { getPlatform, type Brand, type Workspace } from '../model';
import { BrandMark, errorText, PageHeader } from '../ui';
import { brandStatuses, useSavedPasswords } from '../brandStatus';
import { useSignIns } from '../useSignIns';
import { useBrowserPosting } from '../useBrowserPosting';
import { brandLanes, DAILY_LIMIT, dayLabel, notReady, stepKey, todaysSteps, type QueueLane, type QueueStep } from '../postQueue';
import { videoPartLabel } from '../series';
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
};

/** The time, moved on every minute, so a new day frees the daily limits without a reload. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  return now;
}

/**
 * The post queue: each brand's finished videos wait their turn on every social, and at most DAILY_LIMIT
 * go up on an account in a day. Until the socials' APIs post by themselves, "Post today's videos" walks
 * through today's posts one at a time: it opens each upload page in the brand's window, Nate presses Post
 * there, and the next one opens once it is recorded.
 */
export default function QueuePage({ workspace, loaded, busy, onSave, onOpenBrand }: Props) {
  const now = useNow();
  const passwords = useSavedPasswords(workspace.accounts);
  const signIns = useSignIns();
  const lanesByBrand = useMemo(() => workspace.brands.map((brand) => ({
    brand, lanes: brandLanes(workspace, brand.id, brandStatuses(workspace, brand.id, { passwords, signIns: signIns[brand.id] }), now),
  })), [workspace, passwords, signIns, now]);
  const browser = useBrowserPosting(workspace, onSave);
  const [running, setRunning] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [started, setStarted] = useState(0);
  const [error, setError] = useState('');
  const steps = todaysSteps(lanesByBrand.flatMap((item) => item.lanes)).filter((step) => !skipped.includes(stepKey(step)));
  const current = running ? steps[0] : undefined;
  const currentKey = current ? stepKey(current) : '';
  const opened = useRef('');
  const video = (step: QueueStep) => workspace.videos?.find((item) => item.id === step.videoId);
  const brandName = (id: string) => workspace.brands.find((brand) => brand.id === id)?.name ?? '';

  async function open(step: QueueStep) {
    const item = video(step);
    if (!item) return;
    setError('');
    try { await browser.post(item, step.platform); }
    catch (reason) { setError(errorText(reason, `Could not open the ${getPlatform(step.platform).name} upload page.`)); setRunning(false); }
  }
  // Opens each step's upload page as it comes up: the first when started, the next once the last is recorded.
  useEffect(() => {
    if (!running) return;
    if (!current) { setRunning(false); return; }
    if (opened.current === currentKey || browser.isOpen(current.videoId, current.platform) || browser.isAsking(current.videoId, current.platform)) return;
    opened.current = currentKey;
    void open(current);
  }, [running, currentKey]);

  function start() { setSkipped([]); opened.current = ''; setStarted(steps.length); setError(''); setRunning(true); }
  function stop() { setRunning(false); opened.current = ''; }
  function skip() { if (current) setSkipped((list) => [...list, stepKey(current)]); }

  const waitingTotal = lanesByBrand.reduce((sum, item) => sum + item.lanes.reduce((count, lane) => count + lane.waiting.length, 0), 0);
  const doneCount = Math.max(0, started - steps.length);
  const disabled = !loaded || busy;

  return <>
    <PageHeader eyebrow="Posting" title="Post queue" description={<>Every finished video waits its turn, oldest first, on each social of its brand. At most {DAILY_LIMIT} go up on an account in a day. Until the socials' APIs post by themselves, you post them: the app opens each upload page with everything filled in, and you press Post.</>}
      actions={!running && <button type="button" className="primary-button" disabled={disabled || steps.length === 0} onClick={start}><Play size={15}/> {steps.length ? `Post today's ${steps.length === 1 ? 'video' : `${steps.length} videos`}` : 'Nothing to post today'}</button>}/>

    {running && current && <section className="card queue-walk" aria-live="polite">
      <div className="queue-walk-head">
        <span className="queue-walk-count">Post {doneCount + 1} of {Math.max(started, doneCount + steps.length)}</span>
        <button type="button" className="ghost-button small-button" onClick={stop}><Square size={13}/> Stop</button>
      </div>
      <Step step={current} title={video(current)?.title ?? ''} part={video(current) ? videoPartLabel(workspace, video(current)!) : null} brand={brandName(current.brandId)} browser={browser} disabled={disabled} onOpen={() => void open(current)} onSkip={skip}/>
    </section>}
    {!running && started > 0 && steps.length === 0 && <section className="card queue-walk queue-walk-done"><Check size={16}/> Today's posts are done. The next ones are due tomorrow.</section>}
    {error && <div className="error-message" role="alert">{error}</div>}

    {workspace.brands.length === 0 ? <section className="card empty-state"><div className="empty-icon"><ListOrdered size={22}/></div><strong>No brands yet</strong><p>Create a brand and make some videos. They line up here.</p></section>
      : waitingTotal === 0 && lanesByBrand.every((item) => item.lanes.every((lane) => lane.today.length === 0)) && <p className="library-hint">Nothing is waiting. Make videos in a brand's Posts tab and they line up here.</p>}

    {lanesByBrand.map(({ brand, lanes }) => <BrandQueue key={brand.id} brand={brand} lanes={lanes} workspace={workspace} current={current} onOpenBrand={onOpenBrand}/>)}
  </>;
}

/** The step being posted: which brand, social and video, and what to do now. */
function Step({ step, title, part, brand, browser, disabled, onOpen, onSkip }: { step: QueueStep; title: string; part: string | null; brand: string; browser: ReturnType<typeof useBrowserPosting>; disabled: boolean; onOpen: () => void; onSkip: () => void }) {
  const name = getPlatform(step.platform).name;
  const asking = browser.isAsking(step.videoId, step.platform);
  const open = browser.isOpen(step.videoId, step.platform);
  const failed = browser.confirmationError(step.videoId, step.platform);
  return <div className="queue-step">
    <BrandMark platform={step.platform}/>
    <div className="queue-step-text">
      <strong>{brand} on {name}</strong>
      <span>{part && <span className="series-badge">{part}</span>}{title}</span>
      <small>{asking ? `Did it go up on ${name}?` : open ? `Check the details in the ${name} window and press Post there. The next one opens once it is up.` : `The ${name} window is closed and this post isn't recorded.`}</small>
      {failed && <span className="error-message" role="alert">{failed}</span>}
    </div>
    <div className="queue-step-actions">
      {asking ? <>
        <button type="button" className="primary-button small-button" disabled={disabled || browser.isConfirming} onClick={() => void browser.confirm({ videoId: step.videoId, platform: step.platform }, true)}><Check size={13}/> Yes, it's up</button>
        <button type="button" className="ghost-button small-button" disabled={browser.isConfirming} onClick={() => void browser.confirm({ videoId: step.videoId, platform: step.platform }, false)}>Not yet</button>
      </> : <button type="button" className="outline-button small-button" disabled={disabled} onClick={onOpen}><AppWindow size={13}/> {open ? 'Open again' : `Open ${name}`}</button>}
      <button type="button" className="ghost-button small-button" disabled={browser.isConfirming} onClick={onSkip}><SkipForward size={13}/> Skip</button>
    </div>
  </div>;
}

/** One brand's socials: what went up today, what goes next, and how long the queue lasts. */
function BrandQueue({ brand, lanes, workspace, current, onOpenBrand }: { brand: Brand; lanes: QueueLane[]; workspace: Workspace; current?: QueueStep; onOpenBrand: Props['onOpenBrand'] }) {
  const unready = notReady(workspace, brand.id);
  const making = unready.filter((video) => video.generation).length;
  const fixing = unready.length - making;
  return <section className="card queue-brand" aria-label={`${brand.name} queue`}>
    <div className="card-title queue-brand-head">
      <div><h2>{brand.name}</h2>{unready.length > 0 && <p>{[making && `${making} being made`, fixing && `${fixing} need${fixing === 1 ? 's' : ''} a file or post details first`].filter(Boolean).join(' · ')}</p>}</div>
      <button type="button" className="ghost-button small-button" onClick={() => onOpenBrand(brand.id)}>Open posts</button>
    </div>
    {lanes.length === 0 ? <p className="library-hint">{brand.name} has no social profiles yet.</p> : <ul className="queue-lanes">
      {lanes.map((lane) => <Lane key={lane.platform} lane={lane} workspace={workspace} current={current} onFix={() => onOpenBrand(brand.id, 'accounts')}/>)}
    </ul>}
  </section>;
}

function Lane({ lane, workspace, current, onFix }: { lane: QueueLane; workspace: Workspace; current?: QueueStep; onFix: () => void }) {
  const name = getPlatform(lane.platform).name;
  const next = lane.status.canPost ? lane.due : lane.waiting.slice(0, DAILY_LIMIT);
  const left = Math.max(0, DAILY_LIMIT - lane.today.length);
  const summary = lane.waiting.length === 0 ? 'Nothing waiting'
    : `${lane.waiting.length} waiting${lane.status.canPost && lane.doneIn !== null ? ` · all up ${dayLabel(lane.doneIn)}` : ''}`;
  return <li className={`queue-lane tone-${lane.status.canPost ? (left === 0 ? 'ok' : 'ready') : lane.status.tone}`}>
    <BrandMark platform={lane.platform} small/>
    <div className="queue-lane-name"><strong>{name}</strong><small>{lane.status.canPost ? summary : lane.status.label}</small></div>
    <div className="queue-pips" aria-label={`${lane.today.length} of ${DAILY_LIMIT} posted today`} title={lane.today.map((video) => video.title).join('\n') || 'Nothing posted today'}>
      {Array.from({ length: DAILY_LIMIT }, (_, index) => <span key={index} className={index < lane.today.length ? 'filled' : ''}/>)}
      <small>{lane.today.length}/{DAILY_LIMIT} today</small>
    </div>
    <div className="queue-next">
      {!lane.status.canPost ? <><small>{lane.status.detail}</small>{lane.status.action && <button type="button" className="dest-button" onClick={onFix}>{lane.status.action.short}</button>}</>
        : left === 0 ? <small>Done for today{lane.waiting.length ? `. Next: ${lane.waiting[0].title}, tomorrow.` : '.'}</small>
        : next.length === 0 ? <small>Nothing waiting.</small>
        : <ol>{next.map((video) => <li key={video.id} className={current?.videoId === video.id && current.platform === lane.platform ? 'current' : ''}>{videoPartLabel(workspace, video) && <span className="series-badge">{videoPartLabel(workspace, video)}</span>}{video.title}</li>)}</ol>}
    </div>
  </li>;
}
