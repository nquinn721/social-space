// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { installLocation, missingTools, newestInstaller, nodeMajor, TOOLS, wingetArgs } from './install.mjs';

describe('npm start install script', () => {
  it('reads the Node major version', () => {
    expect(nodeMajor('v22.11.0')).toBe(22);
    expect(nodeMajor('18.0.0')).toBe(18);
    expect(nodeMajor('nonsense')).toBe(0);
  });

  it('lists missing tools with the C++ build tools before Rust', () => {
    expect(missingTools({ git: true, rust: true, msvc: true, webview2: true })).toEqual([]);
    expect(missingTools({ git: true, rust: false, msvc: false, webview2: true })).toEqual(['msvc', 'rust']);
    expect(missingTools({})).toEqual(['git', 'msvc', 'rust', 'webview2']);
  });

  it('installs every tool silently through winget, with the C++ workload for the build tools', () => {
    for (const key of Object.keys(TOOLS)) {
      const args = wingetArgs(key);
      expect(args.slice(0, 4)).toEqual(['install', '--id', TOOLS[key].winget[0], '-e']);
      expect(args).toContain('--accept-package-agreements');
    }
    expect(wingetArgs('msvc').at(-1)).toMatch(/Workload\.VCTools/);
  });

  it('picks the newest installer written by this build', () => {
    const files = [
      { name: 'Social Space_0.8.0_x64-setup.exe', mtimeMs: 50 },
      { name: 'Social Space_0.9.0_x64-setup.exe', mtimeMs: 200 },
      { name: 'Social Space_0.9.0_x64-setup.nsis.zip', mtimeMs: 300 },
    ];
    expect(newestInstaller(files, 100)).toBe('Social Space_0.9.0_x64-setup.exe');
    expect(newestInstaller(files, 250)).toBeNull();
  });

  it('reads the install folder from reg query output', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\...\\Social Space\r\n    InstallLocation    REG_SZ    "C:\\Users\\a\\AppData\\Local\\Social Space"\r\n';
    expect(installLocation(out)).toBe('C:\\Users\\a\\AppData\\Local\\Social Space');
    expect(installLocation('ERROR: not found')).toBeNull();
  });
});
