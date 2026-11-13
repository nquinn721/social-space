import { BadgeCheck, CircleAlert } from 'lucide-react';
import { finishedUnseen } from './appReviews';

/** A notice at the top of every page when a developer-app review finishes, until it is dismissed. */
export default function ReviewNotice({ marks, onOpen, onDismiss }: { marks?: Record<string, number>; onOpen: () => void; onDismiss: (providers: string[]) => void }) {
  const finished = finishedUnseen(marks);
  if (!finished.length) return null;
  const rejected = finished.some((item) => item.state === 'rejected');
  return <div role="status" className={`notice review-notice ${rejected ? 'rejected' : ''}`} aria-label="App review finished">
    {rejected ? <CircleAlert size={16}/> : <BadgeCheck size={16}/>}
    <span>{finished.map(({ review, state }) => state === 'approved' ? `${review.name} approved. ${review.unlocks}` : `${review.name} was not approved. Read the email, fix what it asks and submit again.`).join(' ')}</span>
    <span className="review-notice-actions">
      <button type="button" className="ghost-button small-button" onClick={onOpen}>See reviews</button>
      <button type="button" className="ghost-button small-button" onClick={() => onDismiss(finished.map((item) => item.review.provider))}>Dismiss</button>
    </span>
  </div>;
}
