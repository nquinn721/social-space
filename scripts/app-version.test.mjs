// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readVersions, setVersion, VERSION_FILES } from './app-version.mjs';
import { buildEnv } from './tauri-build.mjs';

function fakeRepo(version) {
  const root = mkdtempSync(join(tmpdir(), 'app-version-'));
  mkdirSync(join(root, 'src-tauri'));
  const files = {
    'package.json': `{\n  "name": "social-manager",\n  "version": "${version}",\n  "devDependencies": { "vite": "^6.1.0" }\n}\n`,
    'package-lock.json': `{\n  "name": "social-manager",\n  "version": "${version}",\n  "packages": {\n    "": {\n      "name": "social-manager",\n      "version": "${version}"\n    },\n    "node_modules/vite": {\n      "version": "6.1.0"\n    }\n  }\n}\n`,
    'src-tauri/tauri.conf.json': `{\n  "productName": "Social Space",\n  "version": "${version}",\n  "identifier": "com.socialmanager.desktop"\n}\n`,
    'src-tauri/Cargo.toml': `[package]\nname = "social-manager"\nversion = "${version}"\n\n[dependencies]\nserde = { version = "1" }\n`,
    'src-tauri/Cargo.lock': `[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "social-manager"\nversion = "${version}"\n`,
    'hub-app.json': `{\n  "id": "social-space",\n  "version": "${version}"\n}\n`,
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  return root;
}

describe('app-version', () => {
  it('reads one version from every file', () => {
    const versions = readVersions(fakeRepo('0.1.0'));
    expect(Object.keys(versions)).toEqual(VERSION_FILES);
    expect(new Set(Object.values(versions))).toEqual(new Set(['0.1.0']));
  });

  it('sets the app version everywhere and leaves dependency versions alone', () => {
    const root = fakeRepo('0.1.0');
    setVersion(root, '0.2.0');
    expect(new Set(Object.values(readVersions(root)))).toEqual(new Set(['0.2.0']));
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toContain('"version": "6.1.0"');
    expect(readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')).toContain('name = "serde"\nversion = "1.0.0"');
    expect(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')).toContain('serde = { version = "1" }');
  });

  it('rejects things that are not versions and writes nothing', () => {
    const root = fakeRepo('0.1.0');
    expect(() => setVersion(root, '0.2')).toThrow(/not a version/);
    expect(new Set(Object.values(readVersions(root)))).toEqual(new Set(['0.1.0']));
  });

  it('keeps the real repository in step', () => {
    const versions = readVersions(join(import.meta.dirname, '..'));
    expect(new Set(Object.values(versions)).size).toBe(1);
  });
});

describe('tauri-build stamping', () => {
  const git = (_tree, args) => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'abc123' : 'D:/Projects/SocialManager/.git');

  it('stamps the commit and owning repository of the tree being built', () => {
    expect(buildEnv({}, 'C:/build', git)).toMatchObject({ SOCIALSPACE_BUILD_COMMIT: 'abc123', SOCIALSPACE_SOURCE_DIR: 'D:/Projects/SocialManager' });
  });

  it('keeps values the updater already chose', () => {
    expect(buildEnv({ SOCIALSPACE_BUILD_COMMIT: 'f'.repeat(40), SOCIALSPACE_SOURCE_DIR: 'E:/repo' }, 'C:/build', git))
      .toMatchObject({ SOCIALSPACE_BUILD_COMMIT: 'f'.repeat(40), SOCIALSPACE_SOURCE_DIR: 'E:/repo' });
  });

  it('falls back when git is unavailable', () => {
    expect(buildEnv({}, 'C:/build', () => '')).toMatchObject({ SOCIALSPACE_BUILD_COMMIT: 'unknown', SOCIALSPACE_SOURCE_DIR: 'C:/build' });
  });
});
