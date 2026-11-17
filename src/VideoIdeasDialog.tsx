import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Sparkles, X } from 'lucide-react';
import type { VideoIdea, VideoIdeaScene } from './assistant/videoIdeas';
import './ideaSuggestions.css';
import './videoIdeas.css';

type Props = { ideas: VideoIdea[]; loading: number | 'all' | null; error: string; onSelect: (idea: VideoIdea, scene: VideoIdeaScene) => void; onReroll: (index: number) => void; onRerollAll: () => void; onClose: () => void };
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function VideoIdeasDialog({ ideas, loading, error, onSelect, onReroll, onRerollAll, onClose }: Props) {
  const title = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) { event.preventDefault(); panel.current.focus(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="idea-suggestions-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="idea-suggestions-dialog video-ideas-dialog" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1}>
      <header className="idea-suggestions-header"><span className="idea-suggestions-icon"><Sparkles size={19}/></span><div className="idea-suggestions-heading"><h2 id={title}>Video ideas for your brand</h2><p>Pick a scene to fill the video form. Generating the video is a separate step.</p></div><button type="button" className="icon-button" aria-label="Close video ideas" onClick={onClose}><X size={19}/></button></header>
      <div className="idea-suggestions-content" aria-busy={loading !== null}>
        {error && <div role="alert" className="error-message">{error}</div>}
        {!ideas.length && loading !== null ? <p role="status" className="idea-suggestions-loading">Finding video ideas…</p> : <ol className="video-ideas-list">{ideas.map((idea, index) => <li className="video-idea" key={index}>
          <div className="video-idea-head"><div><h3>{idea.title}</h3><p>{idea.description}</p></div><button type="button" className="icon-button" aria-label={`Reroll video idea ${index + 1}`} disabled={loading !== null} onClick={() => onReroll(index)}><RefreshCw size={15} className={loading === index ? 'spin' : ''}/></button></div>
          {idea.scenes.length > 1 && <p className="video-idea-note">{idea.scenes.length} separate clips. Generate each scene individually; combine them in a video editor.</p>}
          {idea.scenes.map((scene, sceneIndex) => <div className="video-idea-scene" key={sceneIndex}><div><strong>{idea.scenes.length > 1 ? `Scene ${sceneIndex + 1}` : 'Video prompt'}</strong><span>{scene.seconds} seconds</span></div><p>{scene.prompt}</p><button type="button" className="outline-button small-button" disabled={loading !== null} onClick={() => onSelect(idea, scene)}>Use {idea.scenes.length > 1 ? `scene ${sceneIndex + 1}` : 'this prompt'}</button></div>)}
        </li>)}</ol>}
      </div>
      <footer className="idea-suggestions-footer"><span role="status">{loading !== null ? 'Asking Grok…' : 'You can edit a prompt before making a video.'}</span><button type="button" className="outline-button" disabled={loading !== null} onClick={onRerollAll}><RefreshCw size={15}/> {error && !ideas.length ? 'Try again' : 'Reroll all'}</button></footer>
    </section>
  </div>, document.body);
}
