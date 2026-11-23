import { useMemo, useState } from 'react';
import type { Workspace } from './model';
import { useAllStatuses } from './brandStatus';
import { planSchedule, type PlannedPost } from './postQueue';
import { useAyrshare } from './useAyrshare';
import { errorText } from './ui';

/**
 * Schedules every ready video into the open posting times of each social that can post (at most 3 a day on an
 * account, three weeks ahead), one post at a time through Ayrshare. Used by Today's "Schedule N ready videos"
 * and the Calendar's "Fill open slots"; with automatic scheduling on, the app does the same by itself.
 */
export function useFillSlots(workspace: Workspace, now: number, brandId?: string) {
  const ayrshare = useAyrshare();
  const all = useAllStatuses(workspace);
  const plan: PlannedPost[] = useMemo(() => workspace.brands.filter((brand) => !brandId || brand.id === brandId)
    .flatMap((brand) => planSchedule(workspace, brand.id, (all[brand.id] ?? []).filter((status) => status.canPost).map((status) => status.platform), now)),
  [workspace, all, now, brandId]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const videos = new Set(plan.map((item) => item.videoId)).size;
  async function fill() {
    if (progress || plan.length === 0) return;
    setError('');
    const items = plan;
    setProgress({ done: 0, total: items.length });
    try {
      for (const [index, item] of items.entries()) {
        const result = await ayrshare.send(item.videoId, item.platform, item.at);
        if (result.post.state === 'failed') throw new Error(result.post.error ?? 'Ayrshare did not take the post.');
        setProgress({ done: index + 1, total: items.length });
      }
    } catch (reason) { setError(errorText(reason, 'Could not schedule the posts.')); }
    finally { setProgress(null); }
  }
  return { plan, videos, fill, progress, error };
}
