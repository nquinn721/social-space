import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ClipboardPaste, Copy, RefreshCw, X as Close } from 'lucide-react';
import { GUIDES, lineParts, readPastedKeys, type KeyField } from './devAppGuides';
import type { DevProvider } from './devAppsService';
import { closeEmbeddedPage, setEmbeddedBounds, type Bounds } from './profileService';
import { embedSetupPage } from './setupService';
import type { SetupPage } from './setupNeeds';
import { BrandMark, errorText } from './ui';
import type { Platform } from './model';
import './setup.css';

const COPIED_MS = 2000;
const SOCIAL_OF: Record<DevProvider, Platform> = { meta: 'instagram', x: 'x', google: 'youtube', tiktok: 'tiktok' };
type Props = { provider: DevProvider; working: boolean; onSave: (id: string, secret: string, configId: string) => Promise<void>; onCancel: () => void };

function boundsOf(element: HTMLElement): Bounds {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height };
}

/**
 * Walks through one social's developer-app setup with the developer site open beside the steps,
 * like the guided sign-up. It only shows pages and copies values: Nate presses every button on the site.
 * The last step takes the keys the site shows; saving them retries the Connect that needed them.
 */
export default function DevAppSetupGuide({ provider, working, onSave, onCancel }: Props) {
  const guide = GUIDES[provider];
  const last = guide.steps.length; // the last step takes the keys
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState<{ page: SetupPage; nonce: number } | null>(null);
  const [windowId, setWindowId] = useState('');
  const [values, setValues] = useState<Record<KeyField, string>>({ id: '', secret: '', config: '' });
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  const step = guide.steps[Math.min(index, last - 1)];
  const onKeys = index === last - 1;
  const ready = guide.fields.every((field) => values[field.key].trim());

  // Entering a step that names a page shows it; other steps keep the page Nate is working on.
  useEffect(() => {
    const page = guide.steps.slice(0, index + 1).reverse().find((item) => item.page)?.page;
    if (page && page !== loaded?.page) setLoaded({ page, nonce: (loaded?.nonce ?? 0) + 1 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  useEffect(() => {
    const element = frame.current;
    if (!loaded || !element) return;
    let cancelled = false;
    setWindowId('');
    embedSetupPage(loaded.page, boundsOf(element))
      .then((id) => { if (!cancelled) setWindowId(id); })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; };
  }, [loaded]);
  useEffect(() => {
    const element = frame.current;
    if (!windowId || !element) return;
    const place = () => { void setEmbeddedBounds(windowId, boundsOf(element)).catch(() => undefined); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    window.addEventListener('resize', place);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); };
  }, [windowId]);
  useEffect(() => () => { void closeEmbeddedPage().catch(() => undefined); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !working) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, onCancel]);

  async function copy(value: string) {
    setError('');
    try { await navigator.clipboard.writeText(value); setCopied(value); setTimeout(() => setCopied((now) => now === value ? '' : now), COPIED_MS); }
    catch { setError('Could not copy. Select the text and copy it yourself.'); }
  }
  function setField(key: KeyField, text: string) {
    if (key === 'id') {
      const keys = readPastedKeys(text);
      if (keys.secret !== undefined) { setValues((now) => ({ ...now, id: keys.id, secret: keys.secret ?? '' })); return; }
    }
    setValues((now) => ({ ...now, [key]: text }));
  }
  async function paste(key: KeyField) {
    setError('');
    try { setField(key, (await navigator.clipboard.readText()).trim()); }
    catch { setError('Could not read the clipboard. Click the box and press Ctrl+V.'); }
  }
  function reload() { setLoaded((now) => now && { ...now, nonce: now.nonce + 1 }); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (working || !ready) return;
    void onSave(values.id.trim(), values.secret.trim(), values.config.trim());
  }

  return <div className="modal-backdrop"><section className="dialog wizard site-open dev-guide" role="dialog" aria-modal="true" aria-labelledby="dev-guide-title">
    <aside className="wizard-rail">
      <h2 id="dev-guide-title">Set up {guide.name}</h2>
      <small className="dev-guide-intro">Once, about {guide.minutes} minutes. Every {guide.name} profile then connects with one click.</small>
      <ol className="wizard-steps">{guide.steps.map((item, at) => <li key={item.title} className={at === index ? 'current' : at < index ? 'done' : ''} aria-current={at === index ? 'step' : undefined}>
        <button type="button" className="dev-guide-step" onClick={() => setIndex(at)}><span className="step-num">{at < index ? <Check size={12} strokeWidth={3}/> : at + 1}</span><span>{item.title}{item.optional && <span className="setup-tag">later is fine</span>}</span></button>
      </li>)}</ol>
    </aside>
    <div className="wizard-main">
      <div className="wizard-top">
        <div><h3 className="wizard-now"><BrandMark platform={SOCIAL_OF[provider]}/><span>Step {index + 1} of {last}: {step.title}</span></h3><p>The {guide.site} site is open below. Follow the steps on the right; you press every button on the site yourself.</p></div>
        <button type="button" className="icon-button" aria-label="Close" disabled={working} onClick={onCancel}><Close size={16}/></button>
      </div>
      <div className="site-stage">
        <div ref={frame} className="site-frame" aria-label="Developer site">{!windowId && <span>{loaded ? 'Loading the page…' : 'This step happens outside the browser. The site opens on the next step.'}</span>}</div>
        <aside className="site-side">
          <ol className="dev-guide-lines">{step.lines.map((line) => <li key={line}>{lineParts(line).map((part, at) => part.label ? <em key={at}>{part.text}</em> : <span key={at}>{part.text}</span>)}</li>)}</ol>
          {step.copy?.map((item) => <div className="dev-guide-copy" key={item.label}>
            <small>{item.label}</small>
            <div className="copy-row"><code>{item.value}</code><button type="button" className="ghost-button small-button" onClick={() => void copy(item.value)}>{copied === item.value ? <><Check size={12}/> Copied</> : <><Copy size={12}/> Copy</>}</button></div>
          </div>)}
          {onKeys && <form className="dev-guide-keys" aria-label={`${guide.name} keys`} onSubmit={submit}>
            <strong>Paste the keys here</strong>
            <small>{guide.where}</small>
            {guide.fields.map((field) => <div key={field.key}>
              <label htmlFor={`dev-${field.key}`}>{field.label}</label>
              <div className="copy-row"><input id={`dev-${field.key}`} type={field.secret ? 'password' : 'text'} autoComplete="off" value={values[field.key]} onChange={(event) => setField(field.key, event.target.value)}/>
                <button type="button" className="ghost-button small-button" aria-label={`Paste ${field.label}`} onClick={() => void paste(field.key)}><ClipboardPaste size={12}/> Paste</button></div>
            </div>)}
            <button className="primary-button" disabled={working || !ready}>{working ? 'Saving…' : 'Save and connect'}</button>
            <small>The keys are kept in Windows Credential Manager and shared with your team's app.</small>
          </form>}
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="wizard-actions"><button type="button" className="outline-button small-button" disabled={!loaded} onClick={reload}><RefreshCw size={14}/> Reload this page</button></div>
        </aside>
      </div>
      <div className="wizard-foot">
        <button type="button" className="outline-button" disabled={index === 0} onClick={() => setIndex((at) => at - 1)}><ArrowLeft size={15}/> Back</button>
        {index < last - 1 && <button type="button" className="primary-button" onClick={() => setIndex((at) => at + 1)}>Done, next step <ArrowRight size={15}/></button>}
      </div>
    </div>
  </section></div>;
}
