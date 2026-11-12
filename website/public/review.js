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

export const TITLE_LIMIT = 200;
export const DESCRIPTION_LIMIT = 5000;
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];

/** Turns "bunny, #Cute snow" into ["bunny", "Cute", "snow"], like the app does. */
export function parseHashtags(text) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(text ?? '').split(/[\s,]+/)) {
    const tag = raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); tags.push(tag); }
  }
  return tags;
}

/** The brand and category picked in the form, from the list Social Space keeps on the site. */
export function pick(catalog, brandId, categoryId) {
  const brand = (catalog?.brands ?? []).find((item) => item.id === brandId);
  const category = brand?.categories?.find((item) => item.id === categoryId);
  return { brand, category };
}

/** What is missing before a new video can be uploaded, or '' when it is ready. */
export function newVideoProblem({ brand, category, title, file, platforms, description }) {
  if (!brand) return 'Pick a brand.';
  if (!category) return 'Pick a category.';
  if (!String(title ?? '').trim()) return 'Give the video a title.';
  if (String(title).trim().length > TITLE_LIMIT) return `Titles are at most ${TITLE_LIMIT} characters.`;
  if (!file) return 'Choose the video file.';
  if (!String(file.type ?? '').startsWith('video/')) return 'That file is not a video.';
  if (!VIDEO_TYPES.includes(file.type)) return 'Use an MP4 or MOV video, the kinds every social takes.';
  if (file.size > MAX_VIDEO_BYTES) return 'Videos can be at most 1 GB.';
  if (String(description ?? '').length > DESCRIPTION_LIMIT) return `Descriptions are at most ${DESCRIPTION_LIMIT} characters.`;
  if (!platforms?.length) return 'Pick at least one social.';
  return '';
}

/** The new post as saved: it waits for approval like any post Social Space sends. Matches the database rules. */
export function newVideoPost({ id, email, brand, category, title, description, hashtags, platforms, madeWithAi, mediaPath, mediaUrl, now = Date.now() }) {
  const cleanTitle = String(title).trim();
  return {
    videoId: id, source: 'partner', createdBy: email.toLowerCase(), brandId: brand.id, categoryId: category.id, brand: brand.name, category: category.name,
    title: cleanTitle, youtubeTitle: cleanTitle.slice(0, 100), description: String(description ?? '').trim(), hashtags, platforms,
    madeWithAi: Boolean(madeWithAi), coverMs: null, mediaPath, mediaUrl, status: 'pending', submittedAt: now, results: {},
    events: [{ at: now, text: `Uploaded by ${email.toLowerCase()}` }],
  };
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
