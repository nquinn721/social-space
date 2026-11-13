import { ArrowRightLeft, BadgeCheck, CircleAlert } from 'lucide-react';
import { finishedUnseen, testVideos, type AppReview } from './appReviews';
import type { Video } from './model';

type Props = {
  marks?: Record<string, number>;
  videos?: Video[];
  busy?: boolean;
  onOpen: () => void;
  onDismiss: (providers: string[]) => void;
  /** Leaves test mode for an approved review: switches to production keys and moves its test videos over. */
  onMove: (review: AppReview) => void;
};

/** A notice at the top of every page when a developer-app review finishes, until it is dismissed. */
export default function ReviewNotice({ marks, videos, busy, onOpen, onDismiss, onMove }: Props) {
  const finished = finishedUnseen(marks);
  if (!finished.length) return null;
  const rejected = finished.some((item) => item.state === 'rejected');
  const moves = finished.filter(({ review, state }) => state === 'approved' && review.test && (review.productionKeys || testVideos(videos, review.test.platform).length > 0));
  return <div role="status" className={`notice review-notice ${rejected ? 'rejected' : ''}`} aria-label="App review finished">
    {rejected ? <CircleAlert size={16}/> : <BadgeCheck size={16}/>}
    <span>{finished.map(({ review, state }) => state === 'approved' ? `${review.name} approved. ${review.unlocks}` : `${review.name} was not approved. Read the email, fix what it asks and submit again.`).join(' ')}</span>
    <span className="review-notice-actions">
      {moves.map(({ review }) => {
        const count = testVideos(videos, review.test!.platform).length;
        const what = [review.productionKeys ? 'Switch to production' : '', count ? `move ${count} test ${count === 1 ? 'video' : 'videos'}` : ''].filter(Boolean).join(' and ');
        return <button type="button" key={review.provider} className="primary-button small-button" disabled={busy} onClick={() => onMove(review)}><ArrowRightLeft size={14}/> {what.charAt(0).toUpperCase() + what.slice(1)}</button>;
      })}
      <button type="button" className="ghost-button small-button" onClick={onOpen}>See reviews</button>
      <button type="button" className="ghost-button small-button" onClick={() => onDismiss(finished.map((item) => item.review.provider))}>Dismiss</button>
    </span>
  </div>;
}
