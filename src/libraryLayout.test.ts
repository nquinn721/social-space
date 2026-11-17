// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const canRun = process.platform === 'win32' && existsSync(edge);

describe.skipIf(!canRun)('destination tile layout', () => {
  it('keeps every X action inside its tile at narrow and wide widths', () => {
    const root = realpathSync(tmpdir());
    const dir = mkdtempSync(join(root, 'socialspace-layout-'));
    try {
      const css = readFileSync(fileURLToPath(new URL('./library.css', import.meta.url)), 'utf8');
      const page = join(dir, 'layout.html');
      writeFileSync(page, `<!doctype html><style>
        * { box-sizing: border-box; } body { margin: 0; font: 14px sans-serif; }
        ${css}
      </style><div id="grid" class="dest-grid">
        <div class="dest" id="x"><span class="platform-mark">X</span><div class="dest-text"><strong>X</strong><small>Session detected</small></div>
          <div class="dest-actions"><button class="dest-button primary">Post</button><button class="dest-link">Copy caption</button><button class="dest-link">Show file</button></div>
        </div>
        <div class="dest" id="facebook"><span class="platform-mark">f</span><div class="dest-text"><strong>Facebook</strong><small>Not connected</small></div><div class="dest-actions"><button class="dest-button">Connect</button></div></div>
      </div><output id="result"></output><script>
        const grid = document.querySelector('#grid');
        const x = document.querySelector('#x');
        const result = [160, 220, 400, 800].map(width => {
          grid.style.width = width + 'px';
          const bounds = x.getBoundingClientRect();
          return { width, gridFits: grid.scrollWidth <= grid.clientWidth,
            actionsFit: [...x.querySelectorAll('button')].every(button => {
              const rect = button.getBoundingClientRect();
              return rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
            }) };
        });
        document.querySelector('#result').textContent = JSON.stringify(result);
      </script>`);
      const html = execFileSync(edge, ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', pathToFileURL(page).href], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const result = html.match(/<output id="result">(.*?)<\/output>/)?.[1];
      expect(result).toBeDefined();
      expect(JSON.parse(result!)).toEqual([160, 220, 400, 800].map(width => ({ width, gridFits: true, actionsFit: true })));
    } finally {
      if (dirname(realpathSync(dir)) !== root) throw new Error('Layout test directory is outside the temporary folder.');
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 35000);
});
