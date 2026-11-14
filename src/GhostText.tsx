import type { InputHTMLAttributes, KeyboardEvent, TextareaHTMLAttributes } from 'react';
import './ghostText.css';

/**
 * Text fields with a suggestion shown as grey ghost text while they are empty. Tab takes the suggestion;
 * typing anything replaces it. Shift+Tab and a field that already has text move focus as usual.
 */
type Ghost = { value: string; suggestion?: string; onAccept: (suggestion: string) => void };

export const GHOST_HINT = 'Press Tab to use the suggestion';

/** The suggestion to show, if any: only while the field is empty and the suggestion has text. */
export function ghostOf(value: string, suggestion?: string): string {
  return !value && suggestion?.trim() ? suggestion : '';
}

function acceptOnTab<T extends HTMLElement>(ghost: string, onAccept: (value: string) => void, next?: (event: KeyboardEvent<T>) => void) {
  return (event: KeyboardEvent<T>) => {
    if (ghost && event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onAccept(ghost);
      return;
    }
    next?.(event);
  };
}

function Hint({ show }: { show: boolean }) {
  return show ? <kbd className="ghost-hint" title={GHOST_HINT}>Tab<span className="sr-only"> to use the suggestion</span></kbd> : null;
}

export function GhostInput({ value, suggestion, onAccept, placeholder, onKeyDown, className, ...rest }: Ghost & Omit<InputHTMLAttributes<HTMLInputElement>, 'value'>) {
  const ghost = ghostOf(value, suggestion);
  return <div className={`ghost-field${ghost ? ' has-ghost' : ''}`}>
    <input {...rest} className={className} value={value} placeholder={ghost || placeholder} title={ghost ? GHOST_HINT : rest.title} onKeyDown={acceptOnTab(ghost, onAccept, onKeyDown)}/>
    <Hint show={Boolean(ghost)}/>
  </div>;
}

export function GhostTextarea({ value, suggestion, onAccept, placeholder, onKeyDown, className, ...rest }: Ghost & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'>) {
  const ghost = ghostOf(value, suggestion);
  return <div className={`ghost-field${ghost ? ' has-ghost' : ''}`}>
    <textarea {...rest} className={className} value={value} placeholder={ghost || placeholder} title={ghost ? GHOST_HINT : rest.title} onKeyDown={acceptOnTab(ghost, onAccept, onKeyDown)}/>
    <Hint show={Boolean(ghost)}/>
  </div>;
}
