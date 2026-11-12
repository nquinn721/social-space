// `npm start`: build Social Space from this checkout and install it, on Windows.
//
// For someone who just cloned the repository: it checks the build tools (Node, Git, Rust, the
// Visual Studio C++ build tools, WebView2), offers to install missing ones with winget, brings a
// `main` checkout up to date, builds the installer through `npm run tauri:build`, installs it
// silently and starts the app. The installed app records this checkout as its source, so its
// Updates page keeps offering new commits on main and rebuilds them here.
//
// Flags: `--yes` installs missing tools without asking, `--no-launch` skips starting the app,
// `--allow-unreleased` builds a branch other than main (a test build that will offer main again).
// Development (hot reload) is `npm run dev:app`.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOW_FLAG, releaseProblem } from './tauri-build.mjs';

export const MIN_NODE_MAJOR = 20;
const EXE_NAME = 'social-manager.exe';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Social Space';
const WEBVIEW2_ID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const WEBVIEW2_KEYS = [
  `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_ID}`,
  `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_ID}`,
  `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_ID}`,
];
const VC_TOOLS_COMPONENT = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64';
const NSIS_DIR = 'src-tauri/target/release/bundle/nsis';

/** Each build tool: how to install it with winget, and where to get it by hand. */
export const TOOLS = {
  git: { name: 'Git', winget: ['Git.Git'], manual: 'https://git-scm.com/download/win' },
  rust: { name: 'Rust (rustup)', winget: ['Rustlang.Rustup'], manual: 'https://rustup.rs' },
  msvc: {
    name: 'Visual Studio C++ Build Tools',
    winget: ['Microsoft.VisualStudio.2022.BuildTools', '--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'],
    manual: 'https://visualstudio.microsoft.com/visual-cpp-build-tools/ (pick "Desktop development with C++")',
  },
  webview2: { name: 'Microsoft Edge WebView2 Runtime', winget: ['Microsoft.EdgeWebView2Runtime'], manual: 'https://developer.microsoft.com/microsoft-edge/webview2/' },
};

/** The major version of a `process.version` string such as "v22.11.0". */
export function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : 0;
}

/** Tool keys (from TOOLS) that are missing, in the order they should be installed. */
export function missingTools(found) {
  return ['git', 'msvc', 'rust', 'webview2'].filter((key) => !found[key]);
}

/** The winget arguments that install `key` without prompts. */
export function wingetArgs(key) {
  const [id, ...extra] = TOOLS[key].winget;
  return ['install', '--id', id, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', ...extra];
}

/** The newest `*-setup.exe` in `files` ([{ name, mtimeMs }]) written at or after `since`, or null. */
export function newestInstaller(files, since) {
  const fresh = files.filter((file) => file.name.endsWith('-setup.exe') && file.mtimeMs >= since);
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return fresh[0]?.name ?? null;
}

/** The InstallLocation value out of `reg query` output, without quotes, or null. */
export function installLocation(regOutput) {
  const match = /InstallLocation\s+REG_\w+\s+(.+)/.exec(regOutput);
  return match ? match[1].trim().replace(/^"|"$/g, '') : null;
}

const run = (program, args, options = {}) => spawnSync(program, args, { encoding: 'utf8', ...options });
const ok = (program, args, options) => {
  const result = run(program, args, options);
  return !result.error && result.status === 0;
};

function cargoBin() {
  return join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'bin');
}

/** Puts rustup's folder on this process's PATH, so a Rust installed a moment ago is usable now. */
function addCargoToPath() {
  const bin = cargoBin();
  const parts = (process.env.PATH || '').split(delimiter);
  if (existsSync(bin) && !parts.some((part) => part.toLowerCase() === bin.toLowerCase())) process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

function detect() {
  addCargoToPath();
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const msvc = existsSync(vswhere) && run(vswhere, ['-products', '*', '-requires', VC_TOOLS_COMPONENT, '-property', 'installationPath']).stdout?.trim();
  return {
    git: ok('git', ['--version']),
    rust: ok('cargo', ['--version']) && ok('rustc', ['--version']),
    msvc: Boolean(msvc),
    webview2: WEBVIEW2_KEYS.some((key) => /pv\s+REG_SZ\s+[1-9]/.test(run('reg', ['query', key, '/v', 'pv']).stdout || '')),
  };
}

async function confirm(question, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function step(label) {
  console.log(`\n== ${label}`);
}

async function ensureTools(yes) {
  step('Checking build tools');
  const major = nodeMajor(process.version);
  if (major < MIN_NODE_MAJOR) fail(`Node.js ${process.version} is too old. Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org and run npm start again.`);
  let missing = missingTools(detect());
  if (missing.length === 0) return console.log('Everything needed is installed.');

  console.log('Missing:');
  for (const key of missing) console.log(`  - ${TOOLS[key].name}`);
  const hasWinget = ok('winget', ['--version']);
  if (hasWinget && (await confirm('Install them now with winget? (Windows may ask for permission; the C++ build tools take a while)', yes))) {
    for (const key of missing) {
      console.log(`\nInstalling ${TOOLS[key].name}...`);
      const result = spawnSync('winget', wingetArgs(key), { stdio: 'inherit' });
      if (result.status !== 0) console.warn(`winget could not install ${TOOLS[key].name} (exit ${result.status}).`);
    }
    // rustup installs the toolchain on first use; make sure the default one (MSVC on Windows) exists.
    addCargoToPath();
    if (missing.includes('rust') && ok('rustup', ['--version'])) spawnSync('rustup', ['default', 'stable'], { stdio: 'inherit' });
    missing = missingTools(detect());
  }
  if (missing.length === 0) return console.log('Everything needed is installed.');
  const lines = missing.map((key) => `  - ${TOOLS[key].name}: ${TOOLS[key].manual}`);
  fail(`Install these, then open a new terminal and run npm start again:\n${lines.join('\n')}`);
}

function updateCheckout(tree, allowUnreleased) {
  step('Getting the latest version');
  const branch = run('git', ['branch', '--show-current'], { cwd: tree }).stdout?.trim();
  if (branch === 'main') {
    if (!ok('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: tree, stdio: 'inherit' })) console.warn('Could not pull main; building what is here.');
  } else {
    run('git', ['fetch', 'origin', 'main'], { cwd: tree });
  }
  const problem = releaseProblem(tree);
  if (problem && !allowUnreleased) fail(`Not building: ${problem}\nRun "git checkout main" (and commit or undo local changes), then npm start again.`);
}

function npm(tree, args) {
  const result = spawnSync('npm', args, { cwd: tree, stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status === 0;
}

const INSTALL_WAIT_SECONDS = 180;

function isRunning(image) {
  return (run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']).stdout || '').toLowerCase().includes(image.toLowerCase());
}

function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function installedExe() {
  const dir = installLocation(run('reg', ['query', UNINSTALL_KEY, '/v', 'InstallLocation']).stdout || '');
  const exe = dir && join(dir, EXE_NAME);
  return exe && existsSync(exe) ? exe : null;
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes') || args.includes('-y');
  const allowUnreleased = args.includes(ALLOW_FLAG);
  const tree = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.platform !== 'win32') fail('npm start installs the Windows app. On another system use npm run dev:app to run it from source.');

  await ensureTools(yes);
  updateCheckout(tree, allowUnreleased);

  step('Installing packages');
  if (!npm(tree, ['ci', '--no-audit', '--no-fund'])) fail('npm ci failed (see above).');

  step('Building Social Space (the first build takes 5 to 15 minutes)');
  const started = Date.now();
  const buildArgs = ['run', 'tauri:build', ...(allowUnreleased ? ['--', ALLOW_FLAG] : [])];
  if (!npm(tree, buildArgs)) fail('The build failed (see above).');
  const nsis = join(tree, NSIS_DIR);
  const files = existsSync(nsis) ? readdirSync(nsis).map((name) => ({ name, mtimeMs: statSync(join(nsis, name)).mtimeMs })) : [];
  const installer = newestInstaller(files, started - 1000);
  if (!installer) fail(`The build finished but no new installer is in ${nsis}.`);

  step('Installing');
  if (isRunning(EXE_NAME)) {
    console.log('Closing the running Social Space so it can be replaced.');
    run('taskkill', ['/IM', EXE_NAME, '/F']);
  }
  const install = spawnSync(join(nsis, installer), ['/S'], { stdio: 'inherit' });
  if (install.status !== 0) fail(`The installer exited with ${install.status}. Run it by hand: ${join(nsis, installer)}`);
  // The NSIS installer can hand the work to a child process and exit early; wait for it to finish.
  for (let waited = 0; waited < INSTALL_WAIT_SECONDS && isRunning(installer); waited++) sleepSeconds(1);
  const exe = installedExe();
  console.log(`Installed ${installer}${exe ? ` to ${dirname(exe)}` : ''}.`);
  console.log('It updates itself from main: open Updates in the app when it says a new version is ready.');

  if (!args.includes('--no-launch') && exe) {
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
    console.log('Started Social Space.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => fail(error?.stack || String(error)));
}
