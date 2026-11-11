import { useState } from 'react';
import { Loader2, UserCheck } from 'lucide-react';
import type { Platform, Video } from './model';
import { canSend, reviewLabel } from './partnerReview';
import { usePartnerReviewContext } from './usePartnerReview';
import { errorText } from './ui';
import { isLocalVideo } from './videoFileService';
import { detailProblems } from './postDetails';

/**
 * On a video waiting for approval: sends it to the partner review site, and shows where its review is.
 * Hidden until partner review is connected under Settings.
 */
export default function PartnerReviewControls({ video, socials, disabled }: { video: Video; socials: Platform[]; disabled: boolean }) {
  const review = usePartnerReviewContext();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  if (!review?.connection || video.generation) return null;
  const post = review.posts[video.id];
  const label = reviewLabel(post);
  const waiting = socials.filter((platform) => !video.posted.includes(platform));
  const sendable = canSend(post) && waiting.length > 0 && isLocalVideo(video.mediaSource);

  async function send() {
    if (sending || !review) return;
    const problems = detailProblems(video, waiting);
    if (problems.length) { setError(problems[0]); return; }
    setSending(true); setError('');
    try { await review.send(video, socials); }
    catch (reason) { setError(errorText(reason, 'Could not send this post for review.')); }
    finally { setSending(false); }
  }

  if (!label && !sendable) return null;
  return <div className="partner-review" aria-label="Partner review">
    {label && <span className={`partner-review-status tone-${label.tone}`} role="status"><UserCheck size={14}/> {label.text}</span>}
    {sendable && <button type="button" className="outline-button small-button" disabled={disabled || sending} onClick={() => void send()}>
      {sending ? <><Loader2 size={14} className="spin"/> Uploading…</> : post ? 'Send to partner again' : 'Send to partner'}
    </button>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </div>;
}
