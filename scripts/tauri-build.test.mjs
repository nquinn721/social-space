// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildEnv, releaseProblem, STAMP_ENV } from './tauri-build.mjs';

const HEAD = 'a'.repeat(40);

/** A fake `git` answering for a tree on `head`, with `main`/`origin/main` tips and `status` output. */
function repo({ head = HEAD, main = HEAD, originMain = '', status = '' } = {}) {
  return (_tree, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head;
    if (args[0] === 'status') return status;
    if (args.includes('refs/heads/main^{commit}')) return main;
    if (args.includes('refs/remotes/origin/main^{commit}')) return originMain;
    return '';
  };
}

describe('tauri-build only builds a clean main', () => {
  it('builds the tip of main or origin/main with nothing changed', () => {
    expect(releaseProblem('C:/tree', repo())).toBeNull();
    // The updater's worktree is detached at the origin/main it fetched.
    expect(releaseProblem('C:/tree', repo({ main: 'b'.repeat(40), originMain: HEAD }))).toBeNull();
  });

  it('refuses a branch, a commit behind main, or uncommitted changes', () => {
    expect(releaseProblem('C:/tree', repo({ main: 'b'.repeat(40) }))).toMatch(/not the tip of main/);
    expect(releaseProblem('C:/tree', repo({ status: ' M src/App.tsx' }))).toMatch(/uncommitted changes:\n M src\/App.tsx/);
    expect(releaseProblem('C:/tree', () => '')).toMatch(/not a git checkout/);
  });

  it('marks the build as stamped so build.rs accepts the release', () => {
    expect(buildEnv({}, 'C:/tree', repo())[STAMP_ENV]).toBe('1');
  });
});
