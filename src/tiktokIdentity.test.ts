import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Exercise the actual script injected into the brand's webview, without a real account.
const source = readFileSync(resolve(process.cwd(), 'src-tauri/src/sign_in_state.rs'), 'utf8');
const script = source.match(/const HANDLE_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!script) throw new Error('Could not find the account identity script');

function observed(path: string, html: string): string {
  const page = document.implementation.createHTMLDocument();
  page.body.innerHTML = html;
  return new Function('document', 'location', `return ${script}`)(page, { hostname: 'www.tiktok.com', pathname: path });
}

describe('TikTok identity check', () => {
  it('reads the owner profile when the edit control is present', () => {
    expect(observed('/@softwings25', '<button>Edit profile</button>')).toBe('softwings25');
  });
  it('does not mistake someone else’s public profile for the signed-in account', () => {
    expect(observed('/@someoneelse', '<button>Follow</button>')).toBe('');
  });
  it('prefers the signed-in profile link over the public page being viewed', () => {
    expect(observed('/@someoneelse', '<a data-e2e="nav-profile" href="/@softwings25">Profile</a>')).toBe('softwings25');
  });
});
