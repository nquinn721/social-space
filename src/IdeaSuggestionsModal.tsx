import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, RefreshCw, Sparkles, X } from 'lucide-react';
import './ideaSuggestions.css';

type Props = {
  ideas: string[];
  loadingAll: boolean;
  loadingIndex: number | null;
  error: string;
  onSelect: (idea: string) => void;
  onRerollAll: () => void;
  onReroll: (index: number) => void;
  onClose: () => void;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A focused chooser for ideas; choosing one does not generate or change the rest of the form. */
export default function IdeaSuggestionsModal({ ideas, loadingAll, loadingIndex, error, onSelect, onRerollAll, onReroll, onClose }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const working = loadingAll || loadingIndex !== null;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) { event.preventDefault(); panel.current.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!panel.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(<div className="idea-suggestions-backdrop" onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onClick={(event) => event.stopPropagation()}>
    <section ref={panel} className="idea-suggestions-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <header className="idea-suggestions-header">
        <span className="idea-suggestions-icon" aria-hidden="true"><Sparkles size={19}/></span>
        <div className="idea-suggestions-heading"><h2 id={titleId}>Find your idea</h2><p id={descriptionId}>Choose a starting point, or try a different idea.</p></div>
        <button type="button" className="icon-button idea-suggestions-close" aria-label="Close suggestions" onClick={onClose}><X size={19}/></button>
      </header>
      <div className="idea-suggestions-content" aria-busy={working}>
        {error && <div role="alert" className="error-message idea-suggestions-error">{error}</div>}
        {!ideas.length && loadingAll ? <div className="idea-suggestions-loading" role="status"><Sparkles size={17}/> Finding ideas…</div>
          : !ideas.length ? <p className="idea-suggestions-empty">No ideas yet. Try again to get suggestions.</p>
            : <ul className="idea-suggestions-list">{ideas.map((idea, index) => <li className="idea-suggestions-item" key={index}>
              <button type="button" className="idea-suggestions-choice" disabled={working} onClick={() => onSelect(idea)}>
                <span>{idea}</span><ArrowRight size={17} aria-hidden="true"/>
              </button>
              <button type="button" className="idea-suggestions-reroll" aria-label={`Reroll suggestion ${index + 1}`} title="Reroll this suggestion" disabled={working} onClick={() => onReroll(index)}>
                <RefreshCw size={16} className={loadingIndex === index ? 'spin' : ''} aria-hidden="true"/>
              </button>
            </li>)}</ul>}
      </div>
      <footer className="idea-suggestions-footer">
        <span role="status">{loadingIndex !== null ? 'Finding a replacement…' : loadingAll && ideas.length ? 'Finding fresh ideas…' : 'Select an idea to add it to your form.'}</span>
        <button type="button" className="outline-button" disabled={working} onClick={onRerollAll}><RefreshCw size={15} className={loadingAll ? 'spin' : ''}/> {error && !ideas.length ? 'Try again' : 'Reroll all'}</button>
      </footer>
    </section>
  </div>, document.body);
}
