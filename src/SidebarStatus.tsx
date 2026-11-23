import { useAyrshare } from './useAyrshare';
import { useResults } from './useResults';
import type { Workspace } from './model';

/** The number of comments still to answer, on the Comments nav item. */
export function CommentCount() {
  const count = useResults().open.length;
  return count > 0 ? <span className="nav-badge" aria-label={`${count} to answer`}>{count}</span> : null;
}

/** "Ayrshare connected · 2 brands · 7 socials linked", at the bottom of the sidebar. */
export function AyrshareStatusPill({ workspace }: { workspace: Workspace }) {
  const ayrshare = useAyrshare();
  const connected = Boolean(ayrshare.status?.connected && ayrshare.status.working !== false);
  const linked = Object.values(ayrshare.brands).reduce((sum, brand) => sum + (brand.socials?.linked.length ?? 0), 0);
  const brands = workspace.brands.length;
  return <div className={`ayrshare-pill ${connected ? '' : 'off'}`} title="Every post goes out through Ayrshare">
    <span className="dot"/><span><strong>{ayrshare.status === null ? 'Checking Ayrshare…' : connected ? 'Ayrshare connected' : 'Ayrshare not connected'}</strong>
      {connected && <small>{brands} {brands === 1 ? 'brand' : 'brands'} · {linked} {linked === 1 ? 'social' : 'socials'} linked</small>}</span>
  </div>;
}
