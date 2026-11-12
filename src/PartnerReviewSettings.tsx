import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, Loader2, Trash2, UserCheck } from 'lucide-react';
import { addReviewer, connectReview, disconnectReview, listReviewers, openReviewSite, removeReviewer, REVIEW_SITE } from './reviewService';
import { usePartnerReviewContext } from './usePartnerReview';
import { errorText } from './ui';

/** Settings: connect the review site, and choose which Google accounts may approve posts there. */
export default function PartnerReviewSettings() {
  const review = usePartnerReviewContext();
  const connection = review?.connection ?? null;
  const [reviewers, setReviewers] = useState<string[] | null>(null);
  const [email, setEmail] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!connection) { setReviewers(null); return; }
    listReviewers().then(setReviewers).catch((reason) => setError(errorText(reason)));
  }, [connection?.clientEmail]);

  async function run(action: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  const connect = () => run(async () => { const made = await connectReview(); if (made) review?.setConnection(made); });
  const disconnect = () => run(async () => { await disconnectReview(); review?.setConnection(null); });
  function add(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    void run(async () => { await addReviewer(email); setEmail(''); setReviewers(await listReviewers()); });
  }
  const remove = (who: string) => {
    if (!window.confirm(`Remove ${who}? They can no longer open the review site.`)) return;
    void run(async () => { await removeReviewer(who); setReviewers(await listReviewers()); });
  };

  return <section className="settings-card" id="partner-review">
    <h2><UserCheck size={17}/> Partner review</h2>
    <p>Send posts to <strong>{REVIEW_SITE.replace('https://', '')}</strong>, where your partner signs in with Google, watches each video and approves or rejects it. Approved posts are posted from this app within a minute, and the site keeps a history of what went where. Keep the app open for approved posts to go out.</p>
    {connection ? <>
      <div className="status-line"><span className="dot"/><span>Connected to {connection.projectId}.</span>
        <button type="button" className="ghost-button small-button" onClick={() => void openReviewSite().catch((reason) => setError(errorText(reason)))}><ExternalLink size={14}/> Open the site</button>
        <button type="button" className="ghost-button small-button" disabled={working} onClick={() => void disconnect()}>Disconnect</button>
      </div>
      {review?.error && <p className="footnote">{review.error}</p>}
      <h3>Who can review</h3>
      {reviewers === null ? <p className="footnote">Loading…</p> : reviewers.length === 0 ? <p className="footnote">Nobody yet. Add your partner's Google account.</p>
        : <ul className="reviewer-list">{reviewers.map((who) => <li key={who}><span>{who}</span><button type="button" className="icon-button" aria-label={`Remove ${who}`} disabled={working} onClick={() => remove(who)}><Trash2 size={14}/></button></li>)}</ul>}
      <form className="inline-add" onSubmit={add}>
        <label htmlFor="reviewer-email" className="sr-only">Google account email</label>
        <input id="reviewer-email" type="email" placeholder="partner@gmail.com" value={email} onChange={(event) => setEmail(event.target.value)}/>
        <button className="outline-button small-button" disabled={working || !email.trim()}>{working ? <Loader2 size={14} className="spin"/> : 'Add'}</button>
      </form>
    </> : <>
      <div className="status-line off"><span className="dot"/><span>Not connected.</span></div>
      <p className="footnote">Choose the review key file (a Google service account key, JSON). It is kept in Windows Credential Manager.</p>
      <button type="button" className="primary-button" disabled={working} onClick={() => void connect()}>{working ? <><Loader2 size={15} className="spin"/> Checking…</> : 'Choose key file'}</button>
    </>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
