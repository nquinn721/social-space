import { describe, expect, it, vi } from 'vitest';
import { isLocalVideo } from './videoFileService';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(), convertFileSrc: vi.fn() }));

describe('isLocalVideo', () => {
  it('accepts Windows drive and network paths', () => {
    expect(isLocalVideo('C:\\Users\\me\\Videos\\SocialSpace\\bunny.mp4')).toBe(true);
    expect(isLocalVideo('d:/clips/bunny.mp4')).toBe(true);
    expect(isLocalVideo('\\\\server\\share\\bunny.mp4')).toBe(true);
  });

  it('rejects web links and relative paths', () => {
    expect(isLocalVideo('https://cdn.example.com/bunny.mp4')).toBe(false);
    expect(isLocalVideo('bunny.mp4')).toBe(false);
    expect(isLocalVideo('')).toBe(false);
  });
});
