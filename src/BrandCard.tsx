import { ChevronRight } from 'lucide-react';
import { getPlatform, type Account, type Brand, type Platform, type Workspace } from './model';
import { brandToDo, type SocialStatus } from './brandStatus';
import { useResults } from './useResults';
import { compact, rangeTotals } from './results';
import { BrandAvatar } from './BrandPicture';
import { BrandMark } from './ui';

/**
 * Posts still to make for a brand: every finished video times every social it has a profile on that it isn't
 * up on or scheduled for yet. `now` counts the ones on socials Ayrshare can post to; `scheduled` the ones
 * Ayrshare already has.
 */
export function postsToMake(workspace: Workspace, brandId: string, statuses: SocialStatus[]) {
  const socials = statuses.filter((status) => status.kind !== 'no-profile').map((status) => status.platform);
  const ready = new Set<Platform>(statuses.filter((status) => status.canPost).map((status) => status.platform));
  let total = 0; let now = 0; let scheduled = 0;
  for (const video of workspace.videos ?? []) {
    if (video.brandId !== brandId || video.generation) continue;
    for (const platform of socials) {
      if (video.posted.includes(platform)) continue;
      if (video.scheduled?.[platform]?.state === 'scheduled') { scheduled += 1; continue; }
      total += 1; if (ready.has(platform)) now += 1;
    }
  }
  return { total, now, scheduled };
}

/** The brand's next post still to go out (scheduled, at or after `now`), if any. */
export function nextPost(workspace: Workspace, brandId: string, now: number) {
  let next: { title: string; at: number } | null = null;
  for (const video of workspace.videos ?? []) {
    if (video.brandId !== brandId) continue;
    for (const post of Object.values(video.scheduled ?? {})) {
      if (post?.state === 'scheduled' && post.at >= now && (!next || post.at < next.at)) next = { title: video.title, at: post.at };
    }
  }
  return next;
}

const nextLabel = (at: number, now: number) => {
  const day = new Date(at); const today = new Date(now); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(day).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000);
  const time = day.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return days === 0 ? `today at ${time}` : days === 1 ? `tomorrow at ${time}` : `${day.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
};

/**
 * A brand at a glance, on Brands: its picture and categories, the socials linked to its Ayrshare profile, a
 * chip when a social needs linking again, and what's scheduled, ready and how it did this week.
 */
export default function BrandCard({ brand, accounts, statuses, workspace, onOpen }: { brand: Brand; accounts: Account[]; statuses: SocialStatus[]; workspace: Workspace; onOpen: () => void }) {
  const results = useResults();
  const now = Date.now();
  const lead = accounts.find((account) => account.imagePath) ?? accounts[0];
  const posts = postsToMake(workspace, brand.id, statuses);
  const linked = statuses.filter((status) => status.canPost);
  const todo = brandToDo(statuses);
  const categories = (workspace.categories ?? []).filter((category) => category.brandId === brand.id).map((category) => category.name);
  const views = rangeTotals(workspace, results.posts, '7d', now, brand.id).current.views;
  const next = nextPost(workspace, brand.id, now);
  const chip = !todo ? null : todo.kind === 'link' ? `Link ${todo.platforms.length === 1 ? getPlatform(todo.platforms[0]).name : `${todo.platforms.length} socials`}` : todo.label;
  return <button type="button" className="brand-card" aria-label={`Open ${brand.name}`} onClick={onOpen}>
    <div className="brand-card-head">
      <BrandAvatar brand={brand} lead={lead}/>
      <div className="brand-card-name"><strong>{brand.name}</strong><small className="muted">{categories.length ? categories.join(' · ') : 'No categories yet'}</small></div>
      <ChevronRight size={16} className="brand-card-go"/>
    </div>
    <div className="brand-card-socials">{linked.map((status) => <span key={status.platform} title={`${getPlatform(status.platform).name}: ${status.detail}`}><BrandMark platform={status.platform} small/></span>)}
      {linked.length === 0 && <small className="muted">No socials linked yet</small>}
      {chip && <span className="status-chip tone-todo"><span className="dot"/>{chip}</span>}</div>
    <div className="brand-card-stats">
      <span><strong>{posts.scheduled}</strong><small>scheduled</small></span>
      <span><strong>{posts.now}</strong><small>ready to schedule</small></span>
      <span><strong>{compact(views)}</strong><small>views, 7 days</small></span>
    </div>
    <div className="brand-card-foot"><span>{next ? <>Next post: <strong>{next.title}</strong> {nextLabel(next.at, now)}</> : (workspace.videos ?? []).some((video) => video.brandId === brand.id) ? 'Nothing scheduled' : 'No videos yet'}</span></div>
  </button>;
}
