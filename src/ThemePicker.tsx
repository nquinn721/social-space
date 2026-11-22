import { useEffect, useRef, useState } from 'react';
import { Palette, Sparkles } from 'lucide-react';
import { applyMotion, applyTheme, celebrate, storedMotion, storedTheme, THEMES, type Motion, type ThemeId } from './look';

/** Sidebar button that picks the app's color theme and turns the fun animations on or off. */
export default function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(storedTheme);
  const [motion, setMotion] = useState<Motion>(storedMotion);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const pick = (id: ThemeId) => { setTheme(id); applyTheme(id); celebrate(60); };
  const toggleMotion = () => { const next = motion === 'fun' ? 'calm' : 'fun'; setMotion(next); applyMotion(next); };
  const current = THEMES.find((item) => item.id === theme) ?? THEMES[0];
  return <div className="theme-picker" ref={box}>
    <button className="nav-item theme-button" aria-expanded={open} aria-label="Colors" title="Colors" onClick={() => setOpen((value) => !value)}>
      <Palette size={17} strokeWidth={1.9}/><span>Colors</span>
      <span className="theme-dots" aria-hidden="true">{current.colors.map((color) => <i key={color} style={{ background: color }}/>)}</span>
    </button>
    {open && <div className="theme-menu" role="dialog" aria-label="Colors">
      <strong>Pick your vibe</strong>
      <div className="theme-options">
        {THEMES.map((item) => <button key={item.id} className={`theme-option ${item.id === theme ? 'selected' : ''}`} aria-pressed={item.id === theme} onClick={() => pick(item.id)}>
          <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${item.colors.join(', ')})` }}/>{item.name}
        </button>)}
      </div>
      <label className="theme-motion"><input type="checkbox" checked={motion === 'fun'} onChange={toggleMotion}/><Sparkles size={14}/> Animations</label>
    </div>}
  </div>;
}
