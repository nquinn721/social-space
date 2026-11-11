// What the review site shows, worked out from the posts Social Space sends. No browser or Firebase here,
// so it can be tested on its own.

export const PLATFORM_NAMES = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X' };
export const NOTE_LIMIT = 1000;

/** Posts waiting for a decision, oldest first, so the queue is worked through in order. */
export function waiting(posts) {
  return posts.filter((post) => post.status === 'pending').sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
}

/** Everything already decided, newest decision first. */
export function decided(posts) {
  return posts.filter((post) => post.status !== 'pending').sort((a, b) => when(b) - when(a));
}
const when = (post) => post.postedAt ?? post.decidedAt ?? post.submittedAt ?? 0;

/** The words and colour for where a post is. */
export function statusLabel(post) {
  switch (post.status) {
    case 'pending': return { text: 'Waiting for review', tone: 'waiting' };
    case 'approved': return { text: 'Approved, posting soon', tone: 'working' };
    case 'posting': return { text: 'Posting now', tone: 'working' };
    case 'posted': return { text: 'Posted', tone: 'good' };
    case 'partly_posted': return { text: 'Partly posted', tone: 'warn' };
    case 'rejected': return { text: 'Rejected', tone: 'bad' };
    default: return { text: post.status ?? 'Unknown', tone: 'waiting' };
  }
}

/** One line per social the post goes to, with how it went there. */
export function platformResults(post) {
  return (post.platforms ?? []).map((platform) => {
    const result = post.results?.[platform];
    const name = PLATFORM_NAMES[platform] ?? platform;
    if (!result) return { platform, name, text: post.status === 'rejected' ? 'Not posted' : 'Not posted yet', tone: 'waiting' };
    if (result.status === 'posted') return { platform, name, text: 'Posted', tone: 'good', url: result.url };
    if (result.status === 'manual') return { platform, name, text: 'Posted by hand from Social Space', tone: 'waiting' };
    return { platform, name, text: result.error ? `Failed: ${result.error}` : 'Failed', tone: 'bad' };
  });
}

/** The text that goes out: the description, then the hashtags. */
export function postText(post) {
  const tags = (post.hashtags ?? []).map((tag) => `#${tag}`).join(' ');
  return [String(post.description ?? '').trim(), tags].filter(Boolean).join('\n\n');
}

/** The decision a reviewer saves. Only these fields may change (the database rules check the same). */
export function decision(status, email, note, now = Date.now()) {
  if (status !== 'approved' && status !== 'rejected') throw new Error('A decision is approved or rejected.');
  return { status, decidedBy: email.toLowerCase(), decidedAt: now, note: String(note ?? '').trim().slice(0, NOTE_LIMIT) };
}

/** "5 min ago", "yesterday 3:04 PM", or a date. */
export function relativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const minutes = Math.round((now - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(now).getFullYear() === date.getFullYear() ? undefined : 'numeric' })
    + ' ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
