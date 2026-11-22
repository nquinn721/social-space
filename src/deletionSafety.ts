import type { Platform, Workspace } from './model';

/** A scheduled Ayrshare post of a profile being removed: its brand, the video and the social. */
export type ScheduledPost = { brandId: string; videoId: string; platform: Platform; id: string };

/** Posts still scheduled in Ayrshare for the profiles being removed (posted ones are left alone). */
export function scheduledForProfiles(workspace: Workspace, accountIds: ReadonlySet<string>): ScheduledPost[] {
  const profiles = workspace.accounts.filter((account) => accountIds.has(account.id) && account.brandId);
  const posts: ScheduledPost[] = [];
  for (const video of workspace.videos ?? []) {
    for (const account of profiles) {
      if (video.brandId !== account.brandId) continue;
      const post = video.scheduled?.[account.platform];
      if (post?.state === 'scheduled' && post.id) posts.push({ brandId: video.brandId, videoId: video.id, platform: account.platform, id: post.id });
    }
  }
  return posts;
}

/** A concurrent workspace merge can keep or restore a profile; its password must stay. */
export function removedProfileIds(ids: ReadonlySet<string>, saved: Workspace, latest: Workspace): string[] {
  return [...ids].filter((id) => !saved.accounts.some((account) => account.id === id) && !latest.accounts.some((account) => account.id === id));
}

type RemovalDependencies = {
  hasPassword: (id: string) => Promise<boolean>;
  /** Cancels one scheduled post in Ayrshare. */
  cancel: (post: ScheduledPost) => Promise<void>;
  confirm: (message: string) => boolean;
  isCurrent: () => boolean;
};

/**
 * Asks before removing profiles from the app, then cancels their posts still scheduled in Ayrshare so
 * nothing goes out for a profile that's gone. Returns how many were cancelled, or null when declined.
 */
export async function prepareProfileRemoval(workspace: Workspace, ids: Set<string>, description: string, deps: RemovalDependencies): Promise<number | null> {
  const pending = scheduledForProfiles(workspace, ids);
  const notice = pending.length ? ` Its ${pending.length} scheduled ${pending.length === 1 ? 'post is' : 'posts are'} cancelled in Ayrshare.` : '';
  if (!deps.confirm(`${description} This removes local details only; live accounts stay on their socials.${notice}`)) return null;
  const savedPasswords = (await Promise.all([...ids].map((id) => deps.hasPassword(id)))).some(Boolean);
  if (savedPasswords && !deps.confirm('This also deletes the saved passwords for these profiles from Social Space. Have you finished with the online accounts and saved any passwords you still need?')) return null;
  if (!deps.isCurrent()) throw new Error('The workspace changed. Review the profiles and try again.');
  let cancelled = 0;
  for (const post of pending) {
    try { await deps.cancel(post); cancelled += 1; }
    catch (reason) { throw new Error(`${cancelled ? `${cancelled} scheduled ${cancelled === 1 ? 'post was' : 'posts were'} cancelled, but ` : ''}Ayrshare could not cancel a scheduled post, so nothing was removed. ${reason instanceof Error ? reason.message : ''}`.trim()); }
  }
  return cancelled;
}
