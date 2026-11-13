import type { DevProvider } from './devAppsService';
import type { EmailSummary } from './emailService';
import type { Platform, Video } from './model';

/**
 * Each social's review of our developer app (TikTok app review, Google's YouTube API audit, Meta App
 * Review). No social has an API for this, so the app reads the result emails sent to the main inbox
 * and the user can also set the state by hand. States are kept in the workspace's `setup` marks (so
 * they sync to the partner's PC and are in the backup) under `review:<provider>:<state>`, with when
 * (ms); the newest one is the current state.
 */
export type ReviewState = 'not-submitted' | 'submitted' | 'approved' | 'rejected';
export const REVIEW_STATES: { id: ReviewState; label: string }[] = [
  { id: 'not-submitted', label: 'Not submitted' },
  { id: 'submitted', label: 'Submitted, waiting' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];
export type AppReview = {
  provider: DevProvider;
  /** What the social calls it. */
  name: string;
  /** What approval unlocks, in plain words. */
  unlocks: string;
  /** The Setup tracker step ticked when the review is approved. */
  setupStep: string;
  /** Plain words that find its emails in the inbox search. */
  search: string;
  /** Matches the sender or subject of a mail about this review. */
  about: RegExp;
  /**
   * Set when posts made before approval are only a test: the social whose posts are limited, the
   * mode's name, and what it means. Those posts are tracked and moved over once approved.
   */
  test?: { platform: Platform; mode: string; limits: string };
  /** Only needed later: the app already works for the user's own accounts without it. */
  optional?: string;
  /** The test mode runs on its own keys (TikTok Sandbox), so production keys replace them on approval. */
  productionKeys?: boolean;
};
export const APP_REVIEWS: AppReview[] = [
  { provider: 'tiktok', name: 'TikTok app review', unlocks: 'Accounts other than the app\'s testers can connect, and the app leaves Sandbox.', setupStep: 'tiktok:app:review', search: 'TikTok', about: /tiktok/i,
    test: { platform: 'tiktok', mode: 'Sandbox', limits: 'TikTok runs on the Sandbox app: only its test users can connect and posts are not public.' }, productionKeys: true },
  { provider: 'google', name: 'YouTube API audit', unlocks: 'Uploads are no longer locked to Private.', setupStep: 'youtube:app:audit', search: 'YouTube API', about: /youtube api|api services|api compliance|yt-api|youtube-api|audit/i,
    test: { platform: 'youtube', mode: 'Testing', limits: 'The Google app is in Testing until the audit: uploads through the app stay Private.' } },
  { provider: 'meta', name: 'Meta App Review', unlocks: 'Any Instagram account can connect without a tester role.', setupStep: 'instagram:app:roles', search: 'App Review', about: /app review|facebookmail|meta for developers/i,
    optional: 'Not needed for your own accounts. In Development mode the app already posts to every Instagram account with a role on it. App Review is only for accounts without a role.' },
];
/** X reviews nothing: an app works as soon as it has keys. */
export const NO_REVIEW: DevProvider[] = ['x'];

export function reviewOf(provider: DevProvider) { return APP_REVIEWS.find((review) => review.provider === provider); }
export function stateLabel(state: ReviewState) { return REVIEW_STATES.find((item) => item.id === state)?.label ?? state; }

const markKey = (provider: DevProvider, state: ReviewState | 'seen') => `review:${provider}:${state}`;
/** When the user last dismissed a finished review's notice. */
export const seenKey = (provider: DevProvider) => markKey(provider, 'seen');

/** The current state of one review, with when it got there (absent while never set). */
export function reviewStatus(marks: Record<string, number> | undefined, provider: DevProvider): { state: ReviewState; at?: number } {
  let best: { state: ReviewState; at?: number } = { state: 'not-submitted' };
  for (const { id } of REVIEW_STATES) {
    const at = marks?.[markKey(provider, id)];
    if (at && (best.at === undefined || at >= best.at)) best = { state: id, at };
  }
  return best;
}

/** The marks after setting a review's state; approval also ticks its Setup tracker step. */
export function withReviewState(marks: Record<string, number> | undefined, provider: DevProvider, state: ReviewState, at = Date.now()): Record<string, number> {
  const next = { ...(marks ?? {}) };
  for (const { id } of REVIEW_STATES) delete next[markKey(provider, id)];
  next[markKey(provider, state)] = at;
  const step = reviewOf(provider)?.setupStep;
  if (step && state === 'approved') next[step] = next[step] ?? at;
  return next;
}

/** A review the user still waits on: not approved, and not an optional one left unsubmitted. */
export function reviewOpen(marks: Record<string, number> | undefined, review: AppReview) {
  const { state } = reviewStatus(marks, review.provider);
  return state !== 'approved' && !(review.optional && state === 'not-submitted');
}

/** Reviews that finished (approved or rejected) since the user last dismissed their notice. */
export function finishedUnseen(marks: Record<string, number> | undefined) {
  return APP_REVIEWS.map((review) => ({ review, ...reviewStatus(marks, review.provider) }))
    .filter(({ review, state, at }) => (state === 'approved' || state === 'rejected') && at !== undefined && at > (marks?.[seenKey(review.provider)] ?? 0));
}

const REJECTED = /\b(not (been )?approved|rejected|declined|denied|unsuccessful|did not pass|didn'?t pass|failed|not pass|changes (are )?(needed|required)|needs? changes|action required|resubmit)\b/i;
const APPROVED = /\b(approved|passed|granted|has been accepted|is now live|is live|completed successfully|congratulations)\b/i;
const SUBMITTED = /\b(received|submitted|submission|under review|in review|being reviewed|we'?re reviewing|we are reviewing)\b/i;
const REVIEWISH = /\b(review|audit|approv|submission|submitted|compliance|quota)/i;

/** Reads one email's sender and subject: which review it is about and what it says, or null. */
export function classifyReviewEmail(mail: Pick<EmailSummary, 'from' | 'subject'>): { provider: DevProvider; state: ReviewState } | null {
  const text = `${mail.from} ${mail.subject}`;
  if (!REVIEWISH.test(mail.subject)) return null;
  const review = APP_REVIEWS.find((item) => item.about.test(text));
  if (!review) return null;
  // A rejection often also says "review" or "approval", so check it first.
  const state: ReviewState | null = REJECTED.test(mail.subject) ? 'rejected' : APPROVED.test(mail.subject) ? 'approved' : SUBMITTED.test(mail.subject) ? 'submitted' : null;
  return state ? { provider: review.provider, state } : null;
}

/** When a mail was sent (ms), or null if its date can't be read. */
export function mailTime(mail: Pick<EmailSummary, 'date'>) {
  const at = Date.parse(mail.date);
  return Number.isFinite(at) ? at : null;
}

/**
 * The review changes a batch of emails brings: only mails newer than the review's current state
 * count, and a review already approved stays approved. Returns null when nothing changes.
 */
export function reviewChangesFrom(marks: Record<string, number> | undefined, mails: EmailSummary[]) {
  let next = marks ?? {};
  const changed: { review: AppReview; state: ReviewState }[] = [];
  const found = mails.map((mail) => ({ mail, at: mailTime(mail), hit: classifyReviewEmail(mail) }))
    .filter((item): item is { mail: EmailSummary; at: number; hit: NonNullable<ReturnType<typeof classifyReviewEmail>> } => item.at !== null && item.hit !== null)
    .sort((a, b) => a.at - b.at);
  for (const { at, hit } of found) {
    const current = reviewStatus(next, hit.provider);
    if (current.state === 'approved' || hit.state === current.state || (current.at !== undefined && at <= current.at)) continue;
    next = withReviewState(next, hit.provider, hit.state, at);
    const review = reviewOf(hit.provider)!;
    const index = changed.findIndex((item) => item.review.provider === hit.provider);
    if (index >= 0) changed.splice(index, 1);
    changed.push({ review, state: hit.state });
  }
  return changed.length ? { marks: next, changed } : null;
}

/** The review that keeps a social in test mode right now, or null once approved (or for socials with none). */
export function testModeOf(marks: Record<string, number> | undefined, platform: Platform) {
  const review = APP_REVIEWS.find((item) => item.test?.platform === platform);
  return review && reviewStatus(marks, review.provider).state !== 'approved' ? review : null;
}

/** A video with new `posted` socials: those marked while their social is in test mode are remembered as test posts. */
export function withPosted(video: Video, posted: Platform[], marks: Record<string, number> | undefined, at = Date.now()): Video {
  const testPosts = { ...(video.testPosts ?? {}) };
  for (const platform of Object.keys(testPosts) as Platform[]) if (!posted.includes(platform)) delete testPosts[platform];
  for (const platform of posted) if (!video.posted.includes(platform) && testModeOf(marks, platform)) testPosts[platform] = at;
  const next: Video = { ...video, posted };
  if (Object.keys(testPosts).length) next.testPosts = testPosts; else delete next.testPosts;
  return next;
}

/** Videos posted to a social while it was in test mode. */
export function testVideos(videos: Video[] | undefined, platform: Platform) {
  return (videos ?? []).filter((video) => video.testPosts?.[platform] !== undefined);
}

/** Moves test posts over: they go back to waiting for that social, to be posted for real. */
export function moveTestVideos(videos: Video[] | undefined, platform: Platform): Video[] {
  return (videos ?? []).map((video) => {
    if (video.testPosts?.[platform] === undefined) return video;
    const { [platform]: _moved, ...rest } = video.testPosts;
    const next: Video = { ...video, posted: video.posted.filter((item) => item !== platform) };
    if (Object.keys(rest).length) next.testPosts = rest; else delete next.testPosts;
    return next;
  });
}
