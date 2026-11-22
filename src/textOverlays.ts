import type { TextAnimation, TextEdit, TextOverlay, TextPosition, TextSize } from './model';

/** Text on a video: what it says, when it shows, and how it comes in. Drawn the same way in the preview and the saved file. */
export const ANIMATIONS: { id: TextAnimation; label: string }[] = [
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'slide', label: 'Slide up' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'none', label: 'None' },
];
export const POSITIONS: { id: TextPosition; label: string }[] = [{ id: 'top', label: 'Top' }, { id: 'middle', label: 'Middle' }, { id: 'bottom', label: 'Bottom' }];
export const SIZES: { id: TextSize; label: string }[] = [{ id: 'small', label: 'S' }, { id: 'medium', label: 'M' }, { id: 'large', label: 'L' }];
export const TEXT_LIMIT = 200;
/** How long text takes to come in and go out, in seconds. */
const IN = 0.45;
const OUT = 0.3;
/** Font height as a share of the video's width, so text looks the same on any resolution. */
const SIZE_SCALE: Record<TextSize, number> = { small: 0.055, medium: 0.075, large: 0.1 };
const Y: Record<TextPosition, number> = { top: 0.2, middle: 0.5, bottom: 0.78 };

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeOutBack = (x: number) => { const c = 1.70158; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };

export type OverlayFrame = { alpha: number; scale: number; offsetY: number; chars: number };

/** How a text looks at second t: hidden (null), or its opacity, scale, slide (share of height) and how many letters show. */
export function overlayFrame(overlay: TextOverlay, t: number): OverlayFrame | null {
  if (!overlay.text.trim() || t < overlay.start || t >= overlay.end) return null;
  const length = overlay.end - overlay.start;
  const inTime = Math.min(IN, length / 3);
  const outTime = Math.min(OUT, length / 4);
  const enter = inTime > 0 ? clamp((t - overlay.start) / inTime) : 1;
  const leave = outTime > 0 ? clamp((overlay.end - t) / outTime) : 1;
  const chars = Array.from(overlay.text).length;
  const frame: OverlayFrame = { alpha: leave, scale: 1, offsetY: 0, chars };
  switch (overlay.animation) {
    case 'fade': frame.alpha = Math.min(enter, leave); break;
    case 'pop': frame.alpha = Math.min(clamp(enter * 2), leave); frame.scale = 0.6 + 0.4 * easeOutBack(enter); break;
    case 'slide': frame.alpha = Math.min(enter, leave); frame.offsetY = 0.06 * (1 - easeOutCubic(enter)); break;
    case 'typewriter': {
      const typing = Math.max(0.3, Math.min(chars * 0.05, length * 0.6));
      frame.chars = Math.min(chars, Math.ceil(chars * clamp((t - overlay.start) / typing)));
      break;
    }
    default: break;
  }
  return frame;
}

type Measure = { measureText: (text: string) => { width: number } };
/** Breaks text into lines that fit maxWidth, keeping the writer's own line breaks. */
export function wrapText(ctx: Measure, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

const FONT = '800 {size}px "Segoe UI", Inter, system-ui, sans-serif';

/** Draws every text showing at second t onto a canvas the size of the video. */
export function drawOverlays(ctx: CanvasRenderingContext2D, overlays: TextOverlay[], t: number, width: number, height: number) {
  for (const overlay of overlays) {
    const frame = overlayFrame(overlay, t);
    if (!frame || frame.alpha <= 0) continue;
    const size = Math.round(width * SIZE_SCALE[overlay.size]);
    ctx.save();
    ctx.font = FONT.replace('{size}', String(size));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const full = wrapText(ctx, overlay.text.trim(), width * 0.84);
    // Typewriter lays out the full text first so the lines don't jump while letters appear.
    let left = frame.chars;
    const lines = full.map((line) => { const letters = Array.from(line); const shown = letters.slice(0, Math.max(0, left)).join(''); left -= letters.length + 1; return shown; });
    const lineHeight = size * 1.18;
    const cx = width / 2;
    const cy = height * (Y[overlay.position] + frame.offsetY);
    ctx.globalAlpha = frame.alpha;
    ctx.translate(cx, cy);
    ctx.scale(frame.scale, frame.scale);
    const top = -((full.length - 1) * lineHeight) / 2;
    if (overlay.style === 'box') {
      const widest = Math.max(...full.map((line) => ctx.measureText(line).width));
      const padX = size * 0.45, padY = size * 0.3;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
      roundRect(ctx, -widest / 2 - padX, top - lineHeight / 2 - padY, widest + padX * 2, full.length * lineHeight + padY * 2, size * 0.3);
      ctx.fill();
    }
    lines.forEach((line, index) => {
      if (!line) return;
      const y = top + index * lineHeight;
      if (overlay.style !== 'box') {
        ctx.lineWidth = Math.max(2, size * 0.16);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.strokeText(line, 0, y);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillText(line, 0, y);
    });
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A new text from `start` (seconds), two and a half seconds long or to the end of the video. */
export function newOverlay(start: number, duration: number, text = '', end?: number): TextOverlay {
  const from = clamp(round(start), 0, Math.max(0, duration - 0.5));
  return { id: crypto.randomUUID(), text, start: from, end: round(Math.min(duration, end ?? from + 2.5)), animation: 'fade', position: 'middle', size: 'medium', style: 'outline' };
}
export const round = (seconds: number) => Math.round(seconds * 10) / 10;

/** Problems that stop the video from being saved, in plain words. */
export function overlayProblems(overlays: TextOverlay[], duration: number): string[] {
  if (!overlays.some((overlay) => overlay.text.trim())) return ['Add some text first.'];
  const problems: string[] = [];
  overlays.forEach((overlay, index) => {
    if (!overlay.text.trim()) return;
    if (overlay.end <= overlay.start) problems.push(`Text ${index + 1} ends before it starts.`);
    else if (duration && overlay.start >= duration) problems.push(`Text ${index + 1} starts after the video ends.`);
  });
  return problems;
}

/**
 * Where the shots change, found by comparing small frames a quarter second apart. Returns the scenes as
 * [start, end] in seconds. A video with no cuts is one scene.
 */
export function scenesFromDifferences(differences: number[], step: number, duration: number): [number, number][] {
  const cuts: number[] = [];
  const sorted = [...differences].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = Math.max(28, typical * 3);
  differences.forEach((difference, index) => {
    const at = round((index + 1) * step);
    if (difference >= threshold && at > 0.6 && duration - at > 0.6 && (!cuts.length || at - cuts[cuts.length - 1] >= 0.8)) cuts.push(at);
  });
  const edges = [0, ...cuts, round(duration)];
  return edges.slice(0, -1).map((start, index) => [start, edges[index + 1]]);
}

/**
 * The moments text goes on: each scene, with long scenes split into beats of about three seconds,
 * so an eight second clip with no cuts still gets a few lines.
 */
export function textBeats(scenes: [number, number][]): [number, number][] {
  const beats: [number, number][] = [];
  for (const [start, end] of scenes) {
    const parts = Math.max(1, Math.round((end - start) / 3.2));
    const each = (end - start) / parts;
    for (let index = 0; index < parts; index += 1) beats.push([round(start + each * index), round(index === parts - 1 ? end : start + each * (index + 1))]);
  }
  return beats.slice(0, 12);
}

const SAMPLE_STEP = 0.25;
/** Finds a video's scenes by seeking through it once. Falls back to one scene if frames can't be read. */
export async function detectScenes(src: string, duration: number): Promise<[number, number][]> {
  const whole: [number, number][] = [[0, round(duration)]];
  try {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.src = src;
    await once(video, 'loadeddata');
    const canvas = document.createElement('canvas');
    canvas.width = 48; canvas.height = 48;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return whole;
    let previous: Uint8ClampedArray | null = null;
    const differences: number[] = [];
    for (let t = 0; t < duration; t += SAMPLE_STEP) {
      video.currentTime = t;
      await once(video, 'seeked');
      ctx.drawImage(video, 0, 0, 48, 48);
      const pixels = ctx.getImageData(0, 0, 48, 48).data;
      if (previous) {
        let sum = 0;
        for (let i = 0; i < pixels.length; i += 4) sum += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]);
        differences.push(sum / (pixels.length / 4) / 3);
      }
      previous = pixels;
    }
    video.removeAttribute('src'); video.load();
    return scenesFromDifferences(differences, SAMPLE_STEP, duration);
  } catch { return whole; }
}

function once(target: HTMLMediaElement, event: string, timeoutMs = 15000) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('The video stopped responding.')); }, timeoutMs);
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('This video could not be read.')); };
    const cleanup = () => { window.clearTimeout(timer); target.removeEventListener(event, done); target.removeEventListener('error', failed); };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
  });
}

/** The best format this app's browser can record: MP4 when it can (what the socials want), else WebM. */
export function recordingFormat(isSupported: (type: string) => boolean = (type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
  const options = [
    { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  return options.find((option) => isSupported(option.mime)) ?? null;
}

/**
 * Plays the video once from the start into a hidden canvas with the text drawn on every frame, records it with its
 * sound, and returns the new file's bytes. Takes as long as the video; the app needs to stay open.
 */
export async function renderVideo(src: string, edit: Pick<TextEdit, 'overlays'>, onProgress: (share: number) => void, signal?: AbortSignal): Promise<{ bytes: Uint8Array; ext: string }> {
  const format = recordingFormat();
  if (!format) throw new Error('This PC cannot record video in the app. Update Microsoft Edge WebView2 and try again.');
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.playsInline = true;
  video.src = src;
  await once(video, 'loadeddata', 30000);
  const width = video.videoWidth, height = video.videoHeight, duration = video.duration;
  if (!width || !height || !Number.isFinite(duration)) throw new Error('This video could not be read.');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw the video.');
  const stream = canvas.captureStream(30);
  // The sound goes only into the recording, not out of the speakers.
  const audio = new AudioContext();
  try {
    const sound = audio.createMediaElementSource(video);
    const out = audio.createMediaStreamDestination();
    sound.connect(out);
    out.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
  } catch { /* A video without sound records without it. */ }
  const recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: Math.min(16_000_000, Math.round(width * height * 30 * 0.25)), audioBitsPerSecond: 160_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  let running = true;
  const draw = () => {
    ctx.drawImage(video, 0, 0, width, height);
    drawOverlays(ctx, edit.overlays, video.currentTime, width, height);
    onProgress(clamp(video.currentTime / duration));
  };
  const loop = () => { if (!running) return; draw(); if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(loop); else requestAnimationFrame(loop); };
  try {
    video.currentTime = 0;
    draw();
    await audio.resume();
    recorder.start(1000);
    loop();
    const ended = new Promise<void>((resolve, reject) => {
      video.onended = () => resolve();
      video.onerror = () => reject(new Error('The video stopped playing while it was being saved.'));
      signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
    void ended.catch(() => undefined);
    await video.play();
    await ended;
    draw();
  } finally {
    running = false;
    video.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    void audio.close();
    video.removeAttribute('src'); video.load();
  }
  onProgress(1);
  const blob = new Blob(chunks, { type: format.mime });
  if (!blob.size) throw new Error('Nothing was recorded. Keep the app open while it saves, then try again.');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: format.ext };
}
