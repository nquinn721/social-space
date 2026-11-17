// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Page and channel name autofill', () => {
  it('fills only identified Page and channel names, never matching login fields', async () => {
    const source = readFileSync(resolve(process.cwd(), 'src-tauri/src/autofill.rs'), 'utf8');
    const script = source.match(/const FILL_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
    expect(script).toBeTruthy();
    document.body.innerHTML = `<input id="login" autocomplete="username" aria-label="Page name for login">
      <input id="email" type="email" aria-label="Channel name">
      <input id="page" aria-label="Page name">
      <input id="channel" aria-label="Channel name">`;
    try {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
      window.eval(`(${script})(${JSON.stringify({ fields: { pageName: 'Mia Page', channelName: 'Mia Channel' }, watch: false, replace: false, signInOnly: false })})`);
      const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
      expect(value('login')).toBe('');
      expect(value('email')).toBe('');
      expect(value('page')).toBe('Mia Page');
      expect(value('channel')).toBe('Mia Channel');
      await Promise.resolve();
    } finally { document.body.innerHTML = ''; }
  });
});
