// `npm run tauri:build [-- tauri build args]`: builds the installer with the commit of the tree
// being built baked in, plus the repository it came from (for a worktree, the main checkout that
// owns the git objects). The self-updater relies on both. Values already in the environment win,
// so the updater can pass the exact commit it reviewed.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};

/** The env the build should run with: stamps added only where not already set. */
export function buildEnv(env, tree, run = git) {
  const next = { ...env };
  if (!next.SOCIALSPACE_BUILD_COMMIT) next.SOCIALSPACE_BUILD_COMMIT = run(tree, ['rev-parse', 'HEAD']) || 'unknown';
  if (!next.SOCIALSPACE_SOURCE_DIR) {
    const common = run(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    next.SOCIALSPACE_SOURCE_DIR = common ? dirname(common) : tree;
  }
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const tree = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const env = buildEnv(process.env, tree);
  console.log(`Building commit ${env.SOCIALSPACE_BUILD_COMMIT} (repository ${env.SOCIALSPACE_SOURCE_DIR})`);
  const result = spawnSync('npx', ['tauri', 'build', ...process.argv.slice(2)], { cwd: tree, env, stdio: 'inherit', shell: process.platform === 'win32' });
  process.exitCode = result.status ?? 1;
}
