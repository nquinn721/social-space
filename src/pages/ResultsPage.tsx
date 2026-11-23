import { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { getPlatform, PLATFORMS, type Workspace } from '../model';
import { BrandMark, PageHeader } from '../ui';
import { useResults } from '../useResults';
import { useAyrshare } from '../useAyrshare';
import { useNow } from '../useNow';
import { change, compact, followersGained, RANGE_DAYS, rangeTotals, topVideos, viewsByDay, viewsBySocial, type Range } from '../results';
import '../today.css';

type Props = { workspace: Workspace; /** On a brand's Results tab: only that brand, no page header. */ brandId?: string; onOpenSettings?: () => void };
const RANGES: { id: Range; label: string }[] = [{ id: 'today', label: 'Today' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' }];
const DAY = 86_400_000;

function Change({ value }: { value: number | null }) {
  if (value === null) return <small>No earlier posts to compare</small>;
  return <small className={`change ${value >= 0 ? 'up' : 'down'}`}>{value >= 0 ? '+' : ''}{value}% vs the period before</small>;
}

/**
 * Views, likes, followers and comments from Ayrshare, for every brand or one. A post's numbers count in the
 * range it went up in; followers come from each linked social's own count, saved once a day on this PC.
 */
export default function ResultsPage({ workspace, brandId, onOpenSettings }: Props) {
  const now = useNow();
  const results = useResults();
  const ayrshare = useAyrshare();
  const [range, setRange] = useState<Range>('7d');
  const [brand, setBrand] = useState(brandId ?? '');
  const scope = brandId ?? (brand || undefined);
  const days = RANGE_DAYS[range];
  const since = now - days * DAY;
  const { current, previous } = rangeTotals(workspace, results.posts, range, now, scope);
  const brandIds = scope ? [scope] : workspace.brands.map((item) => item.id);
  const gained = brandIds.map((id) => followersGained(results.history[id] ?? [], days, now)).filter((value): value is number => value !== null);
  const followers = brandIds.reduce((sum, id) => sum + Object.values(results.followers[id] ?? {}).reduce((total, value) => total + (value ?? 0), 0), 0);
  const perDay = viewsByDay(workspace, results.posts, Math.max(7, days), now, scope);
  const most = Math.max(1, ...perDay.map((item) => item.views));
  const bySocial = viewsBySocial(workspace, results.posts, since, scope);
  const socialMost = Math.max(1, ...Object.values(bySocial).map((item) => item?.views ?? 0));
  const top = topVideos(workspace, results.posts, since, scope);
  const connected = Boolean(ayrshare.status?.connected && ayrshare.status.working !== false);
  const brandName = (id: string) => workspace.brands.find((item) => item.id === id)?.name ?? '';

  const controls = <>
    {!brandId && <><label className="sr-only" htmlFor="results-brand">Brand</label>
      <select id="results-brand" value={brand} onChange={(event) => setBrand(event.target.value)}><option value="">All brands</option>{workspace.brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></>}
    <button type="button" className="outline-button" disabled={results.loading || !connected} onClick={() => void results.refresh()}>{results.loading ? <Loader2 size={15} className="spin"/> : <RefreshCw size={15}/>} Refresh</button>
  </>;

  return <>
    {brandId ? <div className="calendar-bar">{controls}</div>
      : <PageHeader eyebrow="From Ayrshare" title="Results" description="Views, likes and followers from Ayrshare, per brand and per social." actions={controls}/>}
    <div className="segmented range-tabs" role="tablist" aria-label="Range">{RANGES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={range === item.id} aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>)}</div>
    {!connected && <div className="status-line off"><span className="dot"/><span>Connect Ayrshare to see results.</span>{onOpenSettings && <button type="button" className="primary-button small-button" onClick={onOpenSettings}>Connect Ayrshare</button>}</div>}
    {results.error && <div className="error-message" role="alert">{results.error}</div>}

    <div className="stat-grid">
      <div className="stat"><span>Views</span><strong>{compact(current.views)}</strong><Change value={change(current.views, previous.views)}/></div>
      <div className="stat"><span>Likes</span><strong>{compact(current.likes)}</strong><Change value={change(current.likes, previous.likes)}/></div>
      <div className="stat"><span>New followers</span><strong>{gained.length ? `${gained.reduce((a, b) => a + b, 0) >= 0 ? '+' : ''}${compact(gained.reduce((a, b) => a + b, 0))}` : '–'}</strong><small>{followers ? `${compact(followers)} in all` : 'Counted once a day from now on'}</small></div>
      <div className="stat"><span>Comments</span><strong>{compact(current.comments)}</strong><Change value={change(current.comments, previous.comments)}/></div>
    </div>

    <div className="results-grid">
      <section className="card" aria-label="Views per day">
        <div className="card-title"><div><h2>Views per day</h2><p>By the day each video went up</p></div></div>
        <div className="bars">{perDay.map((item) => <div key={item.day} className="bar" title={`${new Date(item.day).toLocaleDateString()}: ${item.views} views`}>
          <span style={{ height: `${(item.views / most) * 100}%` }}/><small>{perDay.length > 10 ? new Date(item.day).getDate() : new Date(item.day).toLocaleDateString(undefined, { weekday: 'short' })}</small>
        </div>)}</div>
      </section>
      <section className="card" aria-label="By social">
        <div className="card-title"><div><h2>By social</h2><p>Views</p></div></div>
        <div className="social-bars">{PLATFORMS.filter((platform) => bySocial[platform.id]).map((platform) => <div key={platform.id} className="social-bar">
          <BrandMark platform={platform.id} small/><span>{platform.name}</span><span className="track"><span style={{ width: `${((bySocial[platform.id]?.views ?? 0) / socialMost) * 100}%` }}/></span><strong>{compact(bySocial[platform.id]?.views ?? 0)}</strong>
        </div>)}{Object.keys(bySocial).length === 0 && <p className="library-hint">No posts went up in this range.</p>}</div>
      </section>
    </div>

    <section className="card" aria-label="Top videos">
      <div className="card-title"><div><h2>Top videos</h2><p>{results.readAt ? `Read from Ayrshare at ${new Date(results.readAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : results.loading ? 'Reading from Ayrshare…' : 'Read from Ayrshare every 30 minutes'}</p></div></div>
      {top.length === 0 ? <p className="library-hint">Results show once videos are up.</p> : <table className="results-table">
        <thead><tr><th>Video</th>{!scope && <th>Brand</th>}<th>On</th><th className="num">Views</th><th className="num">Likes</th><th className="num">Comments</th><th className="num">Shares</th></tr></thead>
        <tbody>{top.map(({ video, total }) => <tr key={video.id}><td>{video.title}</td>{!scope && <td>{brandName(video.brandId)}</td>}
          <td><span className="today-socials">{video.posted.map((platform) => <BrandMark key={platform} platform={platform} small/>)}</span></td>
          <td className="num">{compact(total.views)}</td><td className="num">{compact(total.likes)}</td><td className="num">{compact(total.comments)}</td><td className="num">{compact(total.shares)}</td></tr>)}</tbody>
      </table>}
    </section>
    {scope && Object.keys(results.followers[scope] ?? {}).length > 0 && <section className="card" aria-label="Followers">
      <div className="card-title"><div><h2>Followers</h2><p>On each linked social</p></div></div>
      <div className="social-bars">{PLATFORMS.filter((platform) => results.followers[scope]?.[platform.id] !== undefined).map((platform) => <div key={platform.id} className="social-bar">
        <BrandMark platform={platform.id} small/><span>{getPlatform(platform.id).name}</span><span/><strong>{compact(results.followers[scope]?.[platform.id] ?? 0)}</strong></div>)}</div>
    </section>}
  </>;
}
