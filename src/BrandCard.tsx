import { ChevronRight } from 'lucide-react';
import { getPlatform, type Account, type Brand, type Platform, type Workspace } from './model';
import { brandSummary, chipLabel, type SocialStatus } from './brandStatus';
import { BrandAvatar } from './BrandPicture';
import { BrandMark } from './ui';

/** Posts still to make for a brand: every finished video times every social it has a profile on and isn't up on yet. */
export function postsToMake(workspace: Workspace, brandId: string, statuses: SocialStatus[]) {
  const socials = statuses.filter((status) => status.kind !== 'no-profile').map((status) => status.platform);
  const ready = new Set<Platform>(statuses.filter((status) => status.canPost).map((status) => status.platform));
  let total = 0; let now = 0;
  for (const video of workspace.videos ?? []) {
    if (video.brandId !== brandId || video.generation) continue;
    for (const platform of socials) if (!video.posted.includes(platform)) { total += 1; if (ready.has(platform)) now += 1; }
  }
  return { total, now };
}

/**
 * A brand at a glance, the same on Overview and Brands: its picture, a status line worked out from its
 * socials, a chip per social with its state, and how many posts are left to make.
 */
export default function BrandCard({ brand, accounts, statuses, workspace, onOpen }: { brand: Brand; accounts: Account[]; statuses: SocialStatus[]; workspace: Workspace; onOpen: () => void }) {
  const lead = accounts.find((account) => account.imagePath) ?? accounts[0];
  const summary = brandSummary(statuses);
  const posts = postsToMake(workspace, brand.id, statuses);
  return <button type="button" className="brand-card" aria-label={`Open ${brand.name}`} onClick={onOpen}>
    <div className="brand-card-head">
      <BrandAvatar brand={brand} lead={lead}/>
      <div className="brand-card-name"><strong>{brand.name}</strong><small className={`brand-summary tone-${summary.tone}`}><span className="dot"/>{summary.short}</small></div>
      <ChevronRight size={16} className="brand-card-go"/>
    </div>
    <div className="brand-card-socials">{statuses.map((status) => <span key={status.platform} className={`mini-social tone-${status.tone}`} title={`${getPlatform(status.platform).name}: ${status.label}. ${status.detail}`}>
      <BrandMark platform={status.platform} small/><span className="mini-social-state">{chipLabel(status)}</span>
    </span>)}</div>
    <div className="brand-card-foot">{posts.total === 0 ? <span>{(workspace.videos ?? []).some((video) => video.brandId === brand.id) ? 'Nothing left to post' : 'No videos yet'}</span> : <><span><strong>{posts.total}</strong> {posts.total === 1 ? 'post' : 'posts'} to make</span>{posts.now < posts.total && <span className="muted">{posts.now} can go out now</span>}</>}</div>
  </button>;
}
