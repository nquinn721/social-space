import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Sparkles, Wand2, X as Close } from 'lucide-react';
import { buildPrompt, buildRefinePrompt, generateProfileImage, STYLES, type GeneratedImage, type ImageStyle } from './imageAiService';
import { errorText } from './ui';
import './imageStudio.css';

const MAX_HISTORY = 8;
const GENERATING = 'Generating with Grok, about 10 to 20 seconds…';
const REFINING = 'Refining with Grok, about 10 to 20 seconds…';

type Result = GeneratedImage & { prompt: string };

/** A picture idea to make straight away, e.g. from the assistant's suggestion. A new key starts a new one. */
export type AutoImage = { description: string; style: ImageStyle; key: number };

/**
 * Makes a profile picture with Grok Imagine: describe it, generate, then
 * regenerate for a new take or refine the current one with a change.
 * Portraits are always of a fictional person.
 */
export default function ProfileImageStudio({ suggestion = '', auto, disabled = false, onUse, onAutoUse, onClose }: { suggestion?: string; auto?: AutoImage; disabled?: boolean; onUse: (path: string) => void; onAutoUse?: (path: string) => void; onClose: () => void }) {
  const [description, setDescription] = useState(auto?.description ?? suggestion);
  const [style, setStyle] = useState<ImageStyle>(auto?.style ?? 'photo');
  const [refinement, setRefinement] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState(0);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const current = results[selected];
  const busy = Boolean(working) || disabled;

  async function run(label: string, action: () => Promise<void>) {
    if (working) return;
    setWorking(label); setError('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(''); }
  }
  function keep(image: GeneratedImage, prompt: string) {
    setResults((list) => [{ ...image, prompt }, ...list].slice(0, MAX_HISTORY));
    setSelected(0);
  }
  // With an auto idea: make the picture without waiting for a click.
  const makeAuto = (idea: AutoImage) => run(GENERATING, async () => {
    setDescription(idea.description); setStyle(idea.style);
    const prompt = buildPrompt(idea.description, idea.style);
    const image = await generateProfileImage({ prompt });
    keep(image, prompt);
    onAutoUse?.(image.path);
  });
  useEffect(() => { panel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, []);
  useEffect(() => { if (auto?.description) void makeAuto(auto); }, [auto?.key]);

  const generate = () => run(GENERATING, async () => {
    const prompt = buildPrompt(description, style);
    keep(await generateProfileImage({ prompt }), prompt);
  });
  const refine = () => run(REFINING, async () => {
    if (!current) return;
    const prompt = buildRefinePrompt(refinement, style);
    keep(await generateProfileImage({ prompt, sourcePath: current.path }), prompt);
    setRefinement('');
  });

  return <section ref={panel} className="image-studio" aria-label="Generate a profile picture">
    <header className="studio-head">
      <h4><Sparkles size={15}/> Generate with Grok</h4>
      <span className="studio-sub">Grok Imagine from xAI, using your xAI key.</span>
      <button type="button" className="icon-button" aria-label="Close image generator" disabled={Boolean(working)} onClick={onClose}><Close size={16}/></button>
    </header>

    <div className="studio-grid">
      <div className="studio-controls">
        <label htmlFor="studio-prompt">Describe the picture</label>
        <textarea id="studio-prompt" rows={3} maxLength={600} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="e.g. woman in her 30s, curly red hair, warm smile, cozy craft studio background"/>
        <div className="studio-options">
          <div className="segmented" role="group" aria-label="Style">{STYLES.map((item) => <button key={item.id} type="button" aria-pressed={style === item.id} onClick={() => setStyle(item.id)}>{item.label}</button>)}</div>
        </div>
        <div className="studio-actions">
          <button type="button" className="primary-button" disabled={busy || !description.trim()} onClick={() => void generate()}><Wand2 size={15}/> {results.length ? 'Regenerate' : 'Generate'}</button>
        </div>
        {current && <div className="studio-refine">
          <label htmlFor="studio-refine">Refine this picture</label>
          <div className="idea-row"><input id="studio-refine" maxLength={300} value={refinement} onChange={(event) => setRefinement(event.target.value)} placeholder="e.g. add glasses, warmer light, blue background" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (refinement.trim() && !busy) void refine(); } }}/>
            <button type="button" className="outline-button" disabled={busy || !refinement.trim()} onClick={() => void refine()}><Sparkles size={14}/> Refine</button></div>
        </div>}
        {working && <p className="studio-working" role="status"><Loader2 size={14} className="spin"/> {working}</p>}
        {error && <div className="error-message" role="alert">{error}</div>}
      </div>

      <div className="studio-result">
        <div className={`studio-canvas ${working ? 'pending' : ''}`}>{current ? <img src={current.preview} alt="Generated profile picture"/> : <span>Your picture shows here</span>}</div>
        {current && <button type="button" className="primary-button studio-use" disabled={busy} onClick={() => onUse(current.path)}><Check size={15}/> Use this picture</button>}
        {results.length > 1 && <div className="studio-history" aria-label="Earlier pictures">{results.map((item, index) => <button key={item.path} type="button" className={index === selected ? 'selected' : ''} aria-label={`Picture ${results.length - index}`} aria-pressed={index === selected} onClick={() => setSelected(index)}><img src={item.preview} alt=""/></button>)}</div>}
      </div>
    </div>
  </section>;
}
