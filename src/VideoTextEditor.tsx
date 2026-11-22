import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Pause, Play, Plus, Sparkles, Trash2, Type, X } from 'lucide-react';
import type { TextEdit, TextOverlay, Video } from './model';
import { ANIMATIONS, POSITIONS, SIZES, detectScenes, drawOverlays, newOverlay, overlayProblems, renderVideo, round, textBeats, TEXT_LIMIT } from './textOverlays';
import { writeOverlays } from './assistant/overlayWriter';
import { saveEditedVideo, videoPreviewUrl } from './videoFileService';
import { useConfirm } from './ConfirmDialog';
import { errorText } from './ui';
import './library.css';
import './videoEditor.css';

type Props = {
  video: Video; brandName: string; brandNotes: string; categoryName: string;
  /** Records the saved file in the library. */
  onSaved: (path: string, edit: TextEdit) => Promise<boolean | undefined>;
  onClose: () => void;
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Puts animated text on a video: text per scene or time range, written by Grok or by hand, previewed live,
 * then saved as a new video file in the same category (the original stays as it is).
 */
export default function VideoTextEditor({ video, brandName, brandNotes, categoryName, onSaved, onClose }: Props) {
  const titleId = useId();
  const sourcePath = video.textEdit?.sourcePath || video.mediaSource;
  const [src, setSrc] = useState('');
  const [overlays, setOverlays] = useState<TextOverlay[]>(() => video.textEdit?.overlays.map((overlay) => ({ ...overlay })) ?? []);
  const [direction, setDirection] = useState(video.textEdit?.direction ?? '');
  const [selected, setSelected] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scenes, setScenes] = useState<[number, number][] | null>(null);
  const [writing, setWriting] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
  const scenesPromise = useRef<Promise<[number, number][]> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const dirty = useRef(false);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    let live = true;
    videoPreviewUrl(sourcePath).then((url) => { if (live) setSrc(url); })
      .catch((reason) => { if (live) setError(errorText(reason, 'Could not open this video. It may have been moved or deleted.')); });
    return () => { live = false; abort.current?.abort(); };
  }, [sourcePath]);

  // The preview: the text drawn over the playing video on every frame, exactly as it will be saved.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const player = videoRef.current, canvas = canvasRef.current;
      if (player && canvas && player.videoWidth) {
        if (canvas.width !== player.videoWidth || canvas.height !== player.videoHeight) { canvas.width = player.videoWidth; canvas.height = player.videoHeight; }
        const ctx = canvas.getContext('2d');
        if (ctx) { ctx.clearRect(0, 0, canvas.width, canvas.height); drawOverlays(ctx, overlaysRef.current, player.currentTime, canvas.width, canvas.height); }
        setTime(player.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  function loaded() {
    const player = videoRef.current;
    if (!player || !Number.isFinite(player.duration)) return;
    const length = round(player.duration);
    setDuration(length);
    if (!scenesPromise.current) {
      scenesPromise.current = detectScenes(src, player.duration);
      void scenesPromise.current.then(setScenes);
    }
  }
  function seek(seconds: number) {
    const player = videoRef.current;
    if (player) player.currentTime = Math.min(Math.max(0, seconds), duration || player.duration || 0);
  }
  function togglePlay() {
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) void player.play(); else player.pause();
  }
  function change(id: string, patch: Partial<TextOverlay>) {
    dirty.current = true;
    setOverlays((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }
  function add(start = time, end?: number) {
    const made = newOverlay(start, duration || 1, '', end);
    dirty.current = true;
    setOverlays((items) => [...items, made].sort((a, b) => a.start - b.start));
    setSelected(made.id);
    window.setTimeout(() => document.getElementById(`overlay-text-${made.id}`)?.focus(), 0);
  }
  function remove(id: string) {
    dirty.current = true;
    setOverlays((items) => items.filter((item) => item.id !== id));
    if (selected === id) setSelected(null);
  }
  function pick(overlay: TextOverlay) {
    setSelected(overlay.id);
    const player = videoRef.current;
    if (player && (player.currentTime < overlay.start || player.currentTime >= overlay.end)) seek(overlay.start);
  }
  const context = () => ({ brand: brandName, notes: brandNotes, category: categoryName, title: video.title, prompt: video.prompt, direction });

  /** Grok writes one text for each scene (long scenes get a few beats). Replaces the current texts after asking. */
  async function writeAll() {
    if (writing || !duration) return;
    if (overlays.some((item) => item.text.trim()) && !(await confirm({ title: 'Replace the text?', body: <p>Grok writes new text for every scene. Your current text is replaced.</p>, confirmLabel: 'Write new text' }))) return;
    setWriting('all'); setError('');
    try {
      const found = scenes ?? (scenesPromise.current ? await scenesPromise.current : [[0, duration]] as [number, number][]);
      const beats = textBeats(found);
      const lines = await writeOverlays({ ...context(), beats });
      const style = overlays[0];
      dirty.current = true;
      setOverlays(beats.map(([start, end], index) => ({ ...newOverlay(start, duration, lines[index].text, end), animation: lines[index].animation, ...(style ? { position: style.position, size: style.size, style: style.style } : {}) })));
      setSelected(null);
      seek(0);
    } catch (reason) { setError(errorText(reason, 'Grok could not write text. Check the assistant under Settings.')); }
    finally { setWriting(null); }
  }
  async function rewrite(overlay: TextOverlay) {
    if (writing) return;
    setWriting(overlay.id); setError('');
    try {
      const [line] = await writeOverlays({ ...context(), beats: [[overlay.start, overlay.end]], avoid: overlays.map((item) => item.text).filter(Boolean) });
      change(overlay.id, { text: line.text });
    } catch (reason) { setError(errorText(reason, 'Grok could not write text. Check the assistant under Settings.')); }
    finally { setWriting(null); }
  }

  const problems = overlayProblems(overlays, duration);
  async function save() {
    if (saving !== null || problems.length || !src) return;
    videoRef.current?.pause();
    setSaving(0); setError('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const kept = overlays.filter((item) => item.text.trim()).map((item) => ({ ...item, text: item.text.trim(), end: Math.min(item.end, duration || item.end) }));
      const { bytes, ext } = await renderVideo(src, { overlays: kept }, setSaving, controller.signal);
      const title = video.textEdit ? video.title : `${video.title} with text`;
      const path = await saveEditedVideo(bytes, { brand: brandName, category: categoryName, title, ext });
      const edit: TextEdit = { sourcePath, sourceVideoId: video.textEdit?.sourceVideoId ?? video.id, overlays: kept, ...(direction.trim() ? { direction: direction.trim() } : {}) };
      if (await onSaved(path, edit)) { dirty.current = false; onClose(); }
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(errorText(reason, 'The video could not be saved.'));
    } finally { abort.current = null; setSaving(null); }
  }
  async function close() {
    if (saving !== null) { abort.current?.abort(); return; }
    if (dirty.current && !(await confirm({ title: 'Close without saving?', body: <p>The text you added isn't saved into a video yet.</p>, confirmLabel: 'Close' }))) return;
    onClose();
  }
  const closeRef = useRef(close); closeRef.current = close;
  const playRef = useRef(togglePlay); playRef.current = togglePlay;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [role="dialog"].confirm-dialog');
      if (event.key === 'Escape' && !document.querySelector('.confirm-dialog')) { event.preventDefault(); void closeRef.current(); }
      else if (event.key === ' ' && !typing && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); playRef.current(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (!duration) return;
    const box = event.currentTarget.getBoundingClientRect();
    const at = (x: number) => seek(((x - box.left) / box.width) * duration);
    at(event.clientX);
    if (event.type !== 'pointerdown') return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => at(moved.clientX);
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }
  const share = (seconds: number) => `${duration ? (seconds / duration) * 100 : 0}%`;
  const busy = saving !== null;

  return createPortal(<div className="modal-backdrop text-editor-backdrop">
    <section className="text-editor" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="text-editor-head">
        <span className="text-editor-icon"><Type size={18}/></span>
        <div><h2 id={titleId}>Add text</h2><p>{video.title}</p></div>
        <button type="button" className="icon-button" aria-label="Close the text editor" onClick={() => void close()}><X size={18}/></button>
      </header>
      <div className="text-editor-body">
        <div className="text-editor-stage">
          <div className="text-editor-screen">
            {src ? <>
              <video ref={videoRef} src={src} crossOrigin="anonymous" preload="auto" playsInline onLoadedMetadata={loaded} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onClick={togglePlay} aria-label={`Preview of ${video.title}`}/>
              <canvas ref={canvasRef} aria-hidden="true"/>
            </> : !error && <div className="text-editor-loading"><Loader2 size={18} className="spin"/></div>}
          </div>
          <div className="text-editor-controls">
            <button type="button" className="icon-button" aria-label={playing ? 'Pause' : 'Play'} disabled={!duration || busy} onClick={togglePlay}>{playing ? <Pause size={16}/> : <Play size={16}/>}</button>
            <span className="text-editor-time">{clock(time)} / {clock(duration)}</span>
            <span className="text-editor-scenes-note">{scenes === null ? 'Finding scenes…' : `${scenes.length} scene${scenes.length === 1 ? '' : 's'}`}</span>
          </div>
          <div className="text-timeline" onPointerDown={scrub} role="slider" aria-label="Video position" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={round(time)} tabIndex={0}
            onKeyDown={(event) => { if (event.key === 'ArrowRight') seek(time + 0.5); if (event.key === 'ArrowLeft') seek(time - 0.5); }}>
            <div className="text-timeline-scenes">{(scenes ?? []).map(([start, end], index) => <span key={start} className="text-timeline-scene" style={{ left: share(start), width: share(end - start) }} title={`Scene ${index + 1}: ${clock(start)} to ${clock(end)}`}>{scenes && scenes.length > 1 ? index + 1 : ''}</span>)}</div>
            <div className="text-timeline-texts">{overlays.map((overlay) => <button type="button" key={overlay.id} className={`text-timeline-bar ${selected === overlay.id ? 'selected' : ''}`} style={{ left: share(overlay.start), width: share(Math.max(0.1, Math.min(overlay.end, duration) - overlay.start)) }}
              onPointerDown={(event) => event.stopPropagation()} onClick={() => pick(overlay)} title={overlay.text || 'Empty text'}>{overlay.text || '…'}</button>)}</div>
            <span className="text-timeline-head" style={{ left: share(time) }}/>
          </div>
          {scenes && scenes.length > 1 && <div className="text-editor-scene-buttons" aria-label="Scenes">{scenes.map(([start, end], index) => <button type="button" key={start} className="ghost-button small-button" disabled={busy} onClick={() => { seek(start); add(start, end); }}><Plus size={13}/> Text for scene {index + 1}</button>)}</div>}
        </div>

        <div className="text-editor-side">
          <div className="text-editor-ai">
            <label htmlFor={`direction-${video.id}`}>What should the text say?</label>
            <div className="text-editor-ai-row">
              <input id={`direction-${video.id}`} maxLength={500} value={direction} onChange={(event) => { setDirection(event.target.value); dirty.current = true; }} placeholder={`e.g. short ${categoryName} quotes`}/>
              <button type="button" className="primary-button small-button" disabled={!duration || writing !== null || busy} onClick={() => void writeAll()}>{writing === 'all' ? <><Loader2 size={14} className="spin"/> Writing…</> : <><Sparkles size={14}/> Write with AI</>}</button>
            </div>
            <p className="library-hint">Grok writes a line for each scene from {brandName}, {categoryName} and this video. Edit anything after.</p>
          </div>
          <ol className="text-list">
            {overlays.map((overlay, index) => <li key={overlay.id} className={`text-card ${selected === overlay.id ? 'selected' : ''}`} onFocus={() => setSelected(overlay.id)} onClick={() => setSelected(overlay.id)}>
              <div className="text-card-head">
                <button type="button" className="text-card-time" onClick={() => pick(overlay)} title="Go to this text">{index + 1} · {clock(overlay.start)}–{clock(overlay.end)}</button>
                <button type="button" className="ghost-button small-button" disabled={writing !== null || busy} aria-label={`Rewrite text ${index + 1} with AI`} title="Rewrite with AI" onClick={() => void rewrite(overlay)}>{writing === overlay.id ? <Loader2 size={13} className="spin"/> : <Sparkles size={13}/>}</button>
                <button type="button" className="icon-button" aria-label={`Remove text ${index + 1}`} disabled={busy} onClick={() => remove(overlay.id)}><Trash2 size={14}/></button>
              </div>
              <label htmlFor={`overlay-text-${overlay.id}`} className="sr-only">Text {index + 1}</label>
              <textarea id={`overlay-text-${overlay.id}`} rows={2} maxLength={TEXT_LIMIT} value={overlay.text} disabled={busy} placeholder="Type the text" onChange={(event) => change(overlay.id, { text: event.target.value })}/>
              <div className="text-card-row">
                <label>From <input type="number" min={0} max={duration} step={0.1} value={overlay.start} disabled={busy} onChange={(event) => change(overlay.id, { start: round(Number(event.target.value) || 0) })}/></label>
                <label>To <input type="number" min={0} max={duration} step={0.1} value={overlay.end} disabled={busy} onChange={(event) => change(overlay.id, { end: round(Number(event.target.value) || 0) })}/></label>
                <button type="button" className="text-button" disabled={busy} title="Start at the current position" onClick={() => change(overlay.id, { start: round(time), end: Math.max(overlay.end, round(time + 0.5)) })}>Start here</button>
                <button type="button" className="text-button" disabled={busy || time <= overlay.start} title="End at the current position" onClick={() => change(overlay.id, { end: round(time) })}>End here</button>
              </div>
              <div className="text-card-row">
                <label>Animation <select value={overlay.animation} disabled={busy} onChange={(event) => { change(overlay.id, { animation: event.target.value as TextOverlay['animation'] }); seek(overlay.start); }}>{ANIMATIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              </div>
              <div className="text-card-row">
                <div className="segmented mini" role="group" aria-label="Position">{POSITIONS.map((item) => <button type="button" key={item.id} aria-pressed={overlay.position === item.id} disabled={busy} onClick={() => change(overlay.id, { position: item.id })}>{item.label}</button>)}</div>
                <div className="segmented mini" role="group" aria-label="Size">{SIZES.map((item) => <button type="button" key={item.id} aria-pressed={overlay.size === item.id} disabled={busy} onClick={() => change(overlay.id, { size: item.id })}>{item.label}</button>)}</div>
                <div className="segmented mini" role="group" aria-label="Look"><button type="button" aria-pressed={overlay.style === 'outline'} disabled={busy} onClick={() => change(overlay.id, { style: 'outline' })}>Outline</button><button type="button" aria-pressed={overlay.style === 'box'} disabled={busy} onClick={() => change(overlay.id, { style: 'box' })}>Box</button></div>
              </div>
            </li>)}
          </ol>
          <button type="button" className="outline-button small-button text-editor-add" disabled={!duration || busy} onClick={() => add()}><Plus size={14}/> Add text at {clock(time)}</button>
        </div>
      </div>
      <footer className="text-editor-foot">
        {error ? <div className="error-message" role="alert">{error}</div>
          : busy ? <span role="status" className="text-editor-progress"><span style={{ width: `${Math.round((saving ?? 0) * 100)}%` }}/>Saving {Math.round((saving ?? 0) * 100)}%. The video plays through once; keep the app open.</span>
          : <span className="library-hint">{overlays.length && problems.length ? problems[0] : `Saves a new video with the text into ${categoryName}. The original stays as it is.`}</span>}
        <button type="button" className="ghost-button" onClick={() => void close()}>{busy ? 'Stop' : 'Cancel'}</button>
        <button type="button" className="primary-button" disabled={busy || !src || problems.length > 0} onClick={() => void save()}>{busy ? <Loader2 size={15} className="spin"/> : null} Save video</button>
      </footer>
      {dialog}
    </section>
  </div>, document.body);
}
