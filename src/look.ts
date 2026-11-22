/**
 * The app's look: a color theme and whether the fun animations run. Both are kept in this PC's
 * browser storage (not the workspace), so they never sync to the partner and never block a load.
 * Also the confetti burst shown when something worth celebrating happens (a post goes out, a brand is made).
 */
export type ThemeId = 'neon' | 'sunset' | 'ocean' | 'candy' | 'forest';
export type Motion = 'fun' | 'calm';
export const THEMES: { id: ThemeId; name: string; colors: [string, string, string] }[] = [
  { id: 'neon', name: 'Neon', colors: ['#ff3d8b', '#8b5cff', '#19d3ff'] },
  { id: 'sunset', name: 'Sunset', colors: ['#ff4f7b', '#ff8a3d', '#ffd23f'] },
  { id: 'ocean', name: 'Ocean', colors: ['#2de2c9', '#3b82ff', '#7c5cff'] },
  { id: 'candy', name: 'Candy', colors: ['#ff6ad5', '#c774e8', '#94d0ff'] },
  { id: 'forest', name: 'Forest', colors: ['#b4f34a', '#2ee6a6', '#19c3ff'] },
];
const THEME_KEY = 'socialspace-theme';
const MOTION_KEY = 'socialspace-motion';

function read(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* storage blocked: the choice still applies for this run */ } }

export function storedTheme(): ThemeId {
  const value = read(THEME_KEY);
  return THEMES.some((theme) => theme.id === value) ? value as ThemeId : 'neon';
}
export function storedMotion(): Motion { return read(MOTION_KEY) === 'calm' ? 'calm' : 'fun'; }

export function applyTheme(theme: ThemeId) { document.documentElement.dataset.theme = theme; write(THEME_KEY, theme); }
export function applyMotion(motion: Motion) { document.documentElement.dataset.motion = motion; write(MOTION_KEY, motion); }
/** Called once before the first render so the saved look shows without a flash. */
export function applyStoredLook() {
  document.documentElement.dataset.theme = storedTheme();
  document.documentElement.dataset.motion = storedMotion();
}

export function motionAllowed() {
  if (document.documentElement.dataset.motion === 'calm') return false;
  try { return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}

/** Success messages that deserve confetti: something went out, got scheduled, or came to life. */
export function isCelebration(message: string) {
  if (/\bnot posted\b|\bremoved\b|\bcancel/i.test(message)) return false;
  return /\bposted on\b|\bscheduled\b|\bpublished\b|\bas live\b|\bis live\b|\ball set\b|\bcreated\b|\bqueued\b/i.test(message);
}

function themeColors() {
  const theme = THEMES.find((item) => item.id === document.documentElement.dataset.theme) ?? THEMES[0];
  return [...theme.colors, '#ffffff', '#ffd23f'];
}

let running = false;
/** A short confetti burst from the top of the window. Skipped when animations are off. */
export function celebrate(pieces = 140) {
  if (running || !motionAllowed() || typeof document === 'undefined') return;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext?.('2d');
  if (!context) return;
  running = true;
  canvas.className = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth, height = window.innerHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  context.scale(ratio, ratio);
  document.body.appendChild(canvas);
  const colors = themeColors();
  const bits = Array.from({ length: pieces }, (_, index) => {
    const fromLeft = index % 2 === 0;
    return {
      x: fromLeft ? width * 0.25 : width * 0.75, y: height * 0.15,
      vx: (Math.random() - 0.5) * 14 + (fromLeft ? -1 : 1) * 2, vy: -Math.random() * 12 - 4,
      size: 5 + Math.random() * 6, spin: Math.random() * Math.PI, turn: (Math.random() - 0.5) * 0.3,
      color: colors[index % colors.length], round: Math.random() < 0.3,
    };
  });
  const start = performance.now();
  const duration = 2200;
  const frame = (now: number) => {
    const t = now - start;
    context.clearRect(0, 0, width, height);
    context.globalAlpha = Math.max(0, 1 - Math.max(0, t - duration * 0.6) / (duration * 0.4));
    for (const bit of bits) {
      bit.vy += 0.32; bit.vx *= 0.985; bit.vy *= 0.985;
      bit.x += bit.vx; bit.y += bit.vy; bit.spin += bit.turn;
      context.save(); context.translate(bit.x, bit.y); context.rotate(bit.spin); context.fillStyle = bit.color;
      if (bit.round) { context.beginPath(); context.arc(0, 0, bit.size / 2, 0, Math.PI * 2); context.fill(); }
      else context.fillRect(-bit.size / 2, -bit.size / 4, bit.size, bit.size / 2);
      context.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else { canvas.remove(); running = false; }
  };
  requestAnimationFrame(frame);
}
