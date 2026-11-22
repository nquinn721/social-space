import { useState } from 'react';
import { Palette, Sparkles } from 'lucide-react';
import { applyMotion, applyTheme, celebrate, storedMotion, storedTheme, THEMES, type Motion, type ThemeId } from './look';

/** Settings → Look: the same themes and animations switch, laid out in a settings card. */
export default function LookSettings() {
  const [theme, setTheme] = useState<ThemeId>(storedTheme);
  const [motion, setMotion] = useState<Motion>(storedMotion);
  const pick = (id: ThemeId) => { setTheme(id); applyTheme(id); celebrate(60); };
  return <section className="settings-card" id="look">
    <h2><Palette size={17}/> Look</h2>
    <p>Colours and animations, on this PC.</p>
    <div className="theme-options look-options">
      {THEMES.map((item) => <button key={item.id} type="button" className={`theme-option ${item.id === theme ? 'selected' : ''}`} aria-pressed={item.id === theme} onClick={() => pick(item.id)}>
        <span className="theme-swatch" style={{ background: `linear-gradient(135deg, ${item.colors.join(', ')})` }}/>{item.name}
      </button>)}
    </div>
    <label className="toggle-row"><input type="checkbox" checked={motion === 'fun'} onChange={() => { const next = motion === 'fun' ? 'calm' : 'fun'; setMotion(next); applyMotion(next); }}/><Sparkles size={14}/> Animations and confetti</label>
  </section>;
}
