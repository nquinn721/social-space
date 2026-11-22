import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';
import { getPlatform, type Workspace } from '../model';
import { BrandMark, errorText, PageHeader } from '../ui';
import { useResults } from '../useResults';
import { useAyrshare } from '../useAyrshare';
import type { Comment } from '../results';
import '../today.css';

type Filter = 'open' | 'answered' | 'all';
type Props = { workspace: Workspace; onOpenSettings?: () => void };

function age(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (!at) return '';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/**
 * New comments on the brands' posts, from every social Ayrshare reads them on. A reply is drafted by Grok,
 * edited here, and sent through Ayrshare to the social the comment is on.
 */
export default function CommentsPage({ workspace, onOpenSettings }: Props) {
  const results = useResults();
  const ayrshare = useAyrshare();
  const [filter, setFilter] = useState<Filter>('open');
  const connected = Boolean(ayrshare.status?.connected && ayrshare.status.working !== false);
  const done = results.comments.filter((comment) => comment.answered || results.handled[comment.id]);
  const shown = filter === 'open' ? results.open : filter === 'answered' ? done : results.comments;
  const FILTERS: { id: Filter; label: string }[] = [{ id: 'open', label: `To answer ${results.open.length}` }, { id: 'answered', label: 'Answered' }, { id: 'all', label: 'All' }];
  return <>
    <PageHeader eyebrow="From Ayrshare" title="Comments" description="New comments on your posts, from every social. Reply here and it goes out through Ayrshare."
      actions={<button type="button" className="outline-button" disabled={results.loading || !connected} onClick={() => void results.refresh()}>{results.loading ? <Loader2 size={15} className="spin"/> : <RefreshCw size={15}/>} Refresh</button>}/>
    <div className="segmented range-tabs" role="tablist" aria-label="Show">{FILTERS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
    {!connected && <div className="status-line off"><span className="dot"/><span>Connect Ayrshare to read comments.</span>{onOpenSettings && <button type="button" className="primary-button small-button" onClick={onOpenSettings}>Connect Ayrshare</button>}</div>}
    {results.error && <div className="error-message" role="alert">{results.error}</div>}
    {shown.length === 0 ? <p className="library-hint">{filter === 'open' ? (results.loading ? 'Reading comments from Ayrshare…' : 'No comments to answer. Comments on posts of the last 14 days show here.') : 'Nothing here yet.'}</p>
      : <ul className="comment-list">{shown.map((comment, index) => <CommentCard autoDraft={filter === 'open' && index < 8} key={`${comment.platform}:${comment.id}`} comment={comment} workspace={workspace} state={comment.answered ? 'answered' : results.handled[comment.id]}/>)}</ul>}
  </>;
}

/** The first few open comments get Grok's draft straight away, so answering is check and send. */
function CommentCard({ comment, workspace, state, autoDraft }: { comment: Comment; workspace: Workspace; state?: 'answered' | 'skipped'; autoDraft?: boolean }) {
  const results = useResults();
  const [text, setText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const video = workspace.videos?.find((item) => item.id === comment.videoId);
  const brand = workspace.brands.find((item) => item.id === comment.brandId);
  const name = getPlatform(comment.platform).name;
  async function draft() {
    setDrafting(true); setError('');
    try { const reply = await results.draft(comment); if (reply) setText(reply); else setError('Grok suggests leaving this one: it looks like spam or a rude comment.'); }
    catch (reason) { setError(errorText(reason, 'Grok could not draft a reply.')); }
    finally { setDrafting(false); }
  }
  useEffect(() => { if (autoDraft && !state) void draft(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function send() {
    setSending(true); setError('');
    try { await results.reply(comment, text); setText(''); }
    catch (reason) { setError(errorText(reason, 'Could not send the reply.')); }
    finally { setSending(false); }
  }
  return <li className={`comment-card ${state ? 'done' : ''}`} aria-label={`Comment from ${comment.author} on ${name}`}>
    <div className="comment-head"><BrandMark platform={comment.platform} small/><strong>{comment.author}</strong>
      <small>on {video?.title ?? 'a post'} · {brand?.name} · {age(comment.at)}</small>{state && <span className="status-chip state-posted"><span className="dot"/>{state === 'answered' ? 'Answered' : 'Skipped'}</span>}</div>
    <p className="comment-text">{comment.text}</p>
    {!state && <div className="comment-reply">
      <label className="sr-only" htmlFor={`reply-${comment.id}`}>Reply to {comment.author}</label>
      <textarea id={`reply-${comment.id}`} value={text} maxLength={2000} placeholder="Write a reply, or let Grok draft one" onChange={(event) => setText(event.target.value)}/>
      <div className="row">
        <small>{text ? `Drafted by Grok: edit before sending. Goes out on ${name}.` : ''}</small>
        <button type="button" className="ghost-button small-button" disabled={drafting || sending} onClick={() => void draft()}>{drafting ? <Loader2 size={13} className="spin"/> : <Sparkles size={13}/>} {text ? 'Draft again' : 'Draft with Grok'}</button>
        <button type="button" className="ghost-button small-button" disabled={sending} onClick={() => results.skip(comment)}>Skip</button>
        <button type="button" className="primary-button small-button" disabled={!text.trim() || sending} onClick={() => void send()}>{sending ? <Loader2 size={13} className="spin"/> : <Send size={13}/>} Send reply</button>
      </div>
      {error && <div className="error-message" role="alert">{error}</div>}
    </div>}
  </li>;
}
