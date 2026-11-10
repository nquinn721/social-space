// Keeps the app version in step everywhere it is written down.
//   npm run app-version            prints each file's version (exit 1 if they disagree)
//   npm run app-version -- 0.3.0   sets every file to 0.3.0
// The rewrites match the Ava hub kit (tools/hub/versions.mjs), so both produce identical files.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SEMVER = /^\d+\.\d+\.\d+$/;
export const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'hub-app.json',
];
const CRATE = 'social-manager';

const FIRST_JSON_VERSION = /("version":\s*")[^"]+(")/;
const CARGO_PACKAGE_VERSION = /(^\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m;
const CARGO_LOCK_ENTRY = new RegExp(`(name = "${CRATE}"\r?\nversion = ")([^"]+)(")`);

/** { read, write } for one version file, picked by its name. */
export function handlerFor(file) {
  const name = file.split('/').pop();
  switch (name) {
    case 'package.json':
    case 'tauri.conf.json':
    case 'hub-app.json':
      return { read: (text) => JSON.parse(text).version, write: (text, v) => text.replace(FIRST_JSON_VERSION, `$1${v}$2`) };
    case 'package-lock.json':
      return {
        read: (text) => {
          const lock = JSON.parse(text);
          return lock.version === lock.packages?.['']?.version ? lock.version : `${lock.version} / ${lock.packages?.['']?.version}`;
        },
        // The top-level version and the root package entry are the first two "version" keys.
        write: (text, v) => { let n = 0; return text.replace(/("version":\s*")[^"]+(")/g, (match, a, b) => (n++ < 2 ? `${a}${v}${b}` : match)); },
      };
    case 'Cargo.toml':
      return { read: (text) => CARGO_PACKAGE_VERSION.exec(text)?.[2], write: (text, v) => text.replace(CARGO_PACKAGE_VERSION, `$1${v}$3`) };
    case 'Cargo.lock':
      return { read: (text) => CARGO_LOCK_ENTRY.exec(text)?.[2], write: (text, v) => text.replace(CARGO_LOCK_ENTRY, `$1${v}$3`) };
    default:
      throw new Error(`Don't know how to version ${file}.`);
  }
}

export function readVersions(root, files = VERSION_FILES) {
  return Object.fromEntries(files.map((file) => [file, handlerFor(file).read(readFileSync(join(root, file), 'utf8'))]));
}

/** Every rewrite is computed and checked first, so a failure leaves nothing half-written. */
export function setVersion(root, version, files = VERSION_FILES) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version like 0.3.0.`);
  const updates = files.map((file) => {
    const { read, write } = handlerFor(file);
    const updated = write(readFileSync(join(root, file), 'utf8'), version);
    if (read(updated) !== version) throw new Error(`Could not update the version in ${file}.`);
    return [join(root, file), updated];
  });
  for (const [path, text] of updates) writeFileSync(path, text);
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = argv[0]?.replace(/^v/, '');
  if (target) {
    setVersion(root, target);
    console.log(`Version set to ${target} in ${VERSION_FILES.join(', ')}.`);
    return 0;
  }
  const versions = readVersions(root);
  for (const [file, version] of Object.entries(versions)) console.log(`${version}\t${file}`);
  return new Set(Object.values(versions)).size === 1 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
