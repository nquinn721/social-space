// `npm run tauri:build [-- tauri build args]`: the only way to build a release. It builds a clean
// main (HEAD must be the tip of main or origin/main with no uncommitted changes), with the commit of
// the tree baked in plus the repository it came from (for a worktree, the main checkout that owns
// the git objects). The self-updater and the Ava hub rely on both. Values already in the
// environment win, so the updater can pass the exact commit it reviewed.
//
// `--allow-unreleased` builds anything anyway (a test build of a branch). Such a build reports a
// commit main does not have, so the next update check offers main again.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Set by this script; src-tauri/build.rs refuses a release build without it. */
export const STAMP_ENV = 'SOCIALSPACE_BUILD_STAMPED';
export const ALLOW_FLAG = '--allow-unreleased';

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};

/** The env the build should run with: stamps added only where not already set. */
export function buildEnv(env, tree, run = git) {
  const next = { ...env, [STAMP_ENV]: '1' };
  if (!next.SOCIALSPACE_BUILD_COMMIT) next.SOCIALSPACE_BUILD_COMMIT = run(tree, ['rev-parse', 'HEAD']) || 'unknown';
  if (!next.SOCIALSPACE_SOURCE_DIR) {
    const common = run(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    next.SOCIALSPACE_SOURCE_DIR = common ? dirname(common) : tree;
  }
  return next;
}

/** Why `tree` must not be built as a release, or null when it is a clean main. */
export function releaseProblem(tree, run = git) {
  const head = run(tree, ['rev-parse', 'HEAD']);
  if (!head) return `${tree} is not a git checkout, so the build could not be stamped with its commit.`;
  const changed = run(tree, ['status', '--porcelain', '--untracked-files=no']);
  if (changed) return `The tree has uncommitted changes:\n${changed}\nCommit or undo them first.`;
  const mains = ['refs/remotes/origin/main', 'refs/heads/main'].map((ref) => run(tree, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).filter(Boolean);
  if (!mains.includes(head)) return `HEAD (${head.slice(0, 7)}) is not the tip of main or origin/main. Releases are built only from main.`;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tree = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const allowUnreleased = args.includes(ALLOW_FLAG);
  const problem = releaseProblem(tree);
  if (problem && !allowUnreleased) {
    console.error(`Not building: ${problem}\n(For a test build of something else, add -- ${ALLOW_FLAG}.)`);
    process.exit(1);
  }
  if (problem) console.warn(`Building an unreleased tree: ${problem}`);
  const env = buildEnv(process.env, tree);
  console.log(`Building commit ${env.SOCIALSPACE_BUILD_COMMIT} (repository ${env.SOCIALSPACE_SOURCE_DIR})`);
  const result = spawnSync('npx', ['tauri', 'build', ...args.filter((arg) => arg !== ALLOW_FLAG)], { cwd: tree, env, stdio: 'inherit', shell: process.platform === 'win32' });
  process.exitCode = result.status ?? 1;
}
