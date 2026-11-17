import type { Workspace } from './model';
import type { QueueJob } from './queueService';

/** Queue items still requiring action for channels attached to the profiles being removed. */
export function queueForProfiles(workspace: Workspace, accountIds: ReadonlySet<string>, jobs: QueueJob[]): QueueJob[] {
  const channelIds = new Set(workspace.channels.filter((channel) => channel.accountId && accountIds.has(channel.accountId)).map((channel) => channel.id));
  return jobs.filter((job) => channelIds.has(job.channelId) && job.status !== 'posted');
}

/** An unlinked legacy channel cannot safely be attributed to or excluded from a brand. */
export function ambiguousQueueForProfiles(workspace: Workspace, accountIds: ReadonlySet<string>, jobs: QueueJob[]): QueueJob[] {
  const platforms = new Set(workspace.accounts.filter((account) => accountIds.has(account.id)).map((account) => account.platform));
  return jobs.filter((job) => {
    if (job.status === 'posted' || !platforms.has(job.platform)) return false;
    const channel = workspace.channels.find((item) => item.id === job.channelId);
    return !channel?.accountId || channel.platform !== job.platform || !workspace.accounts.some((account) => account.id === channel.accountId && account.platform === job.platform);
  });
}

/** A concurrent workspace merge can keep or restore a profile; its password must stay. */
export function removedProfileIds(ids: ReadonlySet<string>, saved: Workspace, latest: Workspace): string[] {
  return [...ids].filter((id) => !saved.accounts.some((account) => account.id === id) && !latest.accounts.some((account) => account.id === id));
}

function queueDescription(job: QueueJob): string {
  const date = new Date(job.scheduledAt);
  const when = Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
  const caption = job.caption.trim().slice(0, 120) || '(no caption)';
  return `${job.platform}: ${job.channelName} (${job.channelHandle || 'no handle'})\nScheduled: ${when}\nCaption: ${caption}`;
}

type RemovalDependencies = {
  list: () => Promise<QueueJob[]>;
  hasPassword: (id: string) => Promise<boolean>;
  cancel: (id: string, onlyUnstarted: boolean) => Promise<void>;
  confirm: (message: string) => boolean;
  isCurrent: () => boolean;
};

/** Confirmation comes before any queue change; uncertain sends always require review. */
export async function prepareProfileRemoval(workspace: Workspace, ids: Set<string>, description: string, deps: RemovalDependencies): Promise<number | null> {
  const jobs = await deps.list();
  const ambiguous = ambiguousQueueForProfiles(workspace, ids, jobs);
  const pending = [...queueForProfiles(workspace, ids, jobs), ...ambiguous];
  if (pending.some((job) => job.status === 'publishing')) throw new Error('A related or unlinked post is being published. Wait for it to finish and check the social before removing this profile.');
  const queueNotice = pending.length ? ` This may also remove ${pending.length} pending ${pending.length === 1 ? 'queue record' : 'queue records'} after you review them.` : '';
  if (!deps.confirm(`${description} This removes local details only; live accounts and Pages remain on their platforms.${queueNotice}`)) return null;
  const savedPasswords = (await Promise.all([...ids].map((id) => deps.hasPassword(id)))).some(Boolean);
  if (savedPasswords && !deps.confirm('This also deletes the saved passwords for these profiles from Social Space. Have you finished with the online accounts and saved any passwords you still need?')) return null;
  for (const job of ambiguous) {
    const details = queueDescription(job);
    if (!deps.confirm(`This queued post is not linked to a saved account:\n${details}\n\nIs it part of the profile you are removing, and do you want its queue record removed? Choose Cancel to keep it and stop removal.`)) return null;
  }
  for (const job of pending.filter((item) => item.status === 'needs_review')) {
    const details = queueDescription(job);
    if (!deps.confirm(`The result of this queued post is uncertain:\n${details}\n\nHave you checked the social and confirmed it is safe to remove this queue record? Removing the record will not delete any post from the social.`)) return null;
  }
  if (!deps.isCurrent()) throw new Error('The workspace changed. Review the profiles and try again.');
  let canceled = 0;
  for (const job of pending) {
    try { await deps.cancel(job.id, job.status !== 'needs_review'); canceled += 1; }
    catch { throw new Error(canceled ? `Could not cancel every queued post. ${canceled} ${canceled === 1 ? 'was' : 'were'} already cancelled; the profile was not removed.` : 'Could not cancel the queued post. The profile was not removed.'); }
  }
  if (!deps.isCurrent()) throw new Error('The workspace changed. Some queued posts may have been cancelled; review it and try again.');
  return canceled;
}
