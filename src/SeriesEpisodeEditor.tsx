import { useRef, useState, type FormEvent } from 'react';
import type { SeriesEpisode } from './model';
import type { EpisodeDraft } from './seriesWriter';

type Props = { episode: SeriesEpisode; disabled: boolean; onSave: (episode: SeriesEpisode) => Promise<boolean | undefined>; onRewrite: (episode: SeriesEpisode, direction: string) => Promise<EpisodeDraft>; onCancel: () => void };
export default function SeriesEpisodeEditor({ episode, disabled, onSave, onRewrite, onCancel }: Props) {
  const [draft, setDraft] = useState(episode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [direction, setDirection] = useState('');
  const [rewriting, setRewriting] = useState(false);
  const guard = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (guard.current || disabled || !draft.title.trim() || !draft.summary.trim()) return;
    guard.current = true; setSaving(true);
    setError('');
    try { if (await onSave({ ...draft, title: draft.title.trim(), summary: draft.summary.trim() })) onCancel(); else setError('Could not save this part. Try again.'); }
    catch { setError('Could not save this part. Try again.'); }
    finally { guard.current = false; setSaving(false); }
  }
  async function rewrite() {
    if (guard.current || disabled) return;
    guard.current = true; setRewriting(true); setError('');
    try { const change = await onRewrite(draft, direction); setDraft((current) => ({ ...current, ...change })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Grok could not revise this part.'); }
    finally { guard.current = false; setRewriting(false); }
  }
  return <form className="series-episode-editor" onSubmit={(event) => void submit(event)} aria-label={`Edit part ${episode.number}`}>
    <fieldset disabled={disabled || rewriting || saving}>
    <label>Part title<input value={draft.title} maxLength={100} onChange={(event) => setDraft({ ...draft, title: event.target.value })}/></label>
    <label>What happens<textarea value={draft.summary} maxLength={800} rows={2} onChange={(event) => setDraft({ ...draft, summary: event.target.value })}/></label>
    <label>Script<textarea value={draft.script ?? ''} maxLength={4000} rows={4} onChange={(event) => setDraft({ ...draft, script: event.target.value })}/></label>
    <label>Video prompt<textarea value={draft.videoPrompt ?? ''} maxLength={1800} rows={4} onChange={(event) => setDraft({ ...draft, videoPrompt: event.target.value })}/></label>
    <label>Caption<textarea value={draft.caption ?? ''} maxLength={1000} rows={2} onChange={(event) => setDraft({ ...draft, caption: event.target.value })}/></label>
    <label>What should Grok change? <span className="library-hint">Optional</span><input value={direction} maxLength={500} disabled={rewriting || saving} onChange={(event) => setDirection(event.target.value)} placeholder="Make the moment more playful"/></label>
    <button type="button" className="outline-button small-button" disabled={disabled || rewriting || saving} onClick={() => void rewrite()}>{rewriting ? 'Grok is writing…' : 'Rewrite draft with Grok'}</button>
    </fieldset>
    {error && <p role="alert" className="error-message">{error}</p>}
    <div className="library-panel-buttons"><button type="button" className="ghost-button" disabled={saving || rewriting} onClick={onCancel}>Cancel</button><button className="primary-button small-button" disabled={disabled || saving || rewriting || !draft.title.trim() || !draft.summary.trim()}>{saving ? 'Saving…' : 'Save part'}</button></div>
  </form>;
}
