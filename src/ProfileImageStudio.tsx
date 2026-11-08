import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Play, RefreshCw, Sparkles, Wand2, X as Close } from 'lucide-react';
import { buildPrompt, generateProfileImage, imageAiStatus, REFINE_STRENGTH, startImageAi, STYLES, type GeneratedImage, type ImageAiStatus, type ImageStyle, type Look, type RefineAmount } from './imageAiService';
import { errorText } from './ui';
import './imageStudio.css';

const LOOKS: { id: Look; label: string; hint: string }[] = [
  { id: 'detailed', label: 'Best quality', hint: 'Qwen-Image, about 1 to 2 minutes' },
  { id: 'fast', label: 'Fast', hint: 'SDXL, about 15 seconds' },
];
const AMOUNTS: RefineAmount[] = ['light', 'medium', 'strong'];
const MAX_HISTORY = 8;

type Result = GeneratedImage & { prompt: string };

/**
 * Makes a profile picture with ComfyUI on this computer: describe it, generate,
 * then regenerate for a new take or refine the current one with a change.
 * Portraits are always of a fictional person.
 */
export default function ProfileImageStudio({ suggestion = '', disabled = false, onUse, onClose }: { suggestion?: string; disabled?: boolean; onUse: (path: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState<ImageAiStatus | null>(null);
  const [description, setDescription] = useState(suggestion);
  const [style, setStyle] = useState<ImageStyle>('photo');
  const [look, setLook] = useState<Look>('detailed');
  const [refinement, setRefinement] = useState('');
  const [amount, setAmount] = useState<RefineAmount>('medium');
  const [results, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState(0);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const current = results[selected];
  const busy = Boolean(working) || disabled;
  const ready = Boolean(status?.running && status.looks.length);
  const lookAvailable = (id: Look) => Boolean(status?.looks.includes(id));

  async function run(label: string, action: () => Promise<void>) {
    if (working) return;
    setWorking(label); setError('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(''); }
  }
  const check = () => run('Checking ComfyUI…', async () => {
    const found = await imageAiStatus();
    setStatus(found);
    if (found.looks.length && !found.looks.includes(look)) setLook(found.looks[0]);
  });
  useEffect(() => { panel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); void check(); }, []);
  const start = () => run('Starting ComfyUI, this takes about a minute…', async () => { await startImageAi(); setStatus(await imageAiStatus()); });

  function keep(image: GeneratedImage, prompt: string) {
    setResults((list) => [{ ...image, prompt }, ...list].slice(0, MAX_HISTORY));
    setSelected(0);
  }
  const generate = () => run(look === 'detailed' ? 'Generating with Qwen-Image, about 1 to 2 minutes…' : 'Generating…', async () => {
    const { prompt, negative } = buildPrompt(description, style);
    keep(await generateProfileImage({ prompt, negative, look }), prompt);
  });
  const refine = () => run(look === 'detailed' ? 'Refining with Qwen-Image, about 1 to 2 minutes…' : 'Refining…', async () => {
    if (!current) return;
    const { prompt, negative } = buildPrompt(description, style, [refinement]);
    keep(await generateProfileImage({ prompt, negative, look, sourcePath: current.path, strength: REFINE_STRENGTH[amount] }), prompt);
    setRefinement('');
  });

  return <section ref={panel} className="image-studio" aria-label="Generate a profile picture">
    <header className="studio-head">
      <h4><Sparkles size={15}/> Generate with local AI</h4>
      <span className="studio-sub">ComfyUI on this PC. Nothing is uploaded.</span>
      <button type="button" className="icon-button" aria-label="Close image generator" disabled={Boolean(working)} onClick={onClose}><Close size={16}/></button>
    </header>

    {status && !ready && <div className="status-line off"><span className="dot">●</span><span>{status.running ? 'ComfyUI is running but has no SDXL or Qwen-Image model.' : 'ComfyUI is not running.'}</span>
      {!status.running && status.canStart && <button type="button" className="outline-button small-button" disabled={busy} onClick={() => void start()}><Play size={13}/> Start ComfyUI</button>}
      <button type="button" className="ghost-button small-button" disabled={busy} onClick={() => void check()}><RefreshCw size={13}/> Check</button></div>}

    <div className="studio-grid">
      <div className="studio-controls">
        <label htmlFor="studio-prompt">Describe the picture</label>
        <textarea id="studio-prompt" rows={3} maxLength={600} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="e.g. woman in her 30s, curly red hair, warm smile, cozy craft studio background"/>
        <div className="studio-options">
          <div className="segmented" role="group" aria-label="Style">{STYLES.map((item) => <button key={item.id} type="button" aria-pressed={style === item.id} onClick={() => setStyle(item.id)}>{item.label}</button>)}</div>
          <div className="segmented" role="group" aria-label="Model">{LOOKS.map((item) => <button key={item.id} type="button" title={item.hint} aria-pressed={look === item.id} disabled={!lookAvailable(item.id)} onClick={() => setLook(item.id)}>{item.label}</button>)}</div>
        </div>
        <div className="studio-actions">
          <button type="button" className="primary-button" disabled={busy || !ready || !description.trim() || !lookAvailable(look)} onClick={() => void generate()}><Wand2 size={15}/> {results.length ? 'Regenerate' : 'Generate'}</button>
        </div>
        {current && <div className="studio-refine">
          <label htmlFor="studio-refine">Refine this picture</label>
          <div className="idea-row"><input id="studio-refine" maxLength={300} value={refinement} onChange={(event) => setRefinement(event.target.value)} placeholder="e.g. add glasses, warmer light, blue background" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (refinement.trim() && !busy) void refine(); } }}/>
            <button type="button" className="outline-button" disabled={busy || !refinement.trim()} onClick={() => void refine()}><Sparkles size={14}/> Refine</button></div>
          <div className="segmented studio-amount" role="group" aria-label="How much to change">{AMOUNTS.map((item) => <button key={item} type="button" aria-pressed={amount === item} onClick={() => setAmount(item)}>{item[0].toUpperCase() + item.slice(1)} change</button>)}</div>
        </div>}
        {working && <p className="studio-working" role="status"><Loader2 size={14} className="spin"/> {working}</p>}
        {error && <div className="error-message" role="alert">{error}</div>}
      </div>

      <div className="studio-result">
        <div className={`studio-canvas ${working && !working.startsWith('Checking') ? 'pending' : ''}`}>{current ? <img src={current.preview} alt="Generated profile picture"/> : <span>Your picture shows here</span>}</div>
        {current && <button type="button" className="primary-button studio-use" disabled={busy} onClick={() => onUse(current.path)}><Check size={15}/> Use this picture</button>}
        {results.length > 1 && <div className="studio-history" aria-label="Earlier pictures">{results.map((item, index) => <button key={item.path} type="button" className={index === selected ? 'selected' : ''} aria-label={`Picture ${results.length - index}`} aria-pressed={index === selected} onClick={() => setSelected(index)}><img src={item.preview} alt=""/></button>)}</div>}
      </div>
    </div>
  </section>;
}
