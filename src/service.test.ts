import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { openKling, openPlatformAction } from './service';
import { openProviderKeys, openProviderSite, openVideo } from './videoSourcesService';
import type { Platform, PlatformAction } from './model';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(false); });
afterEach(() => vi.restoreAllMocks());

describe('desktop-only external actions', () => {
  const platforms: Platform[] = ['x', 'instagram', 'tiktok', 'youtube'];
  const actions: PlatformAction[] = ['create', 'manage', 'post', 'developer'];
  it('rejects every platform action in the browser without opening a window', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    for (const platform of platforms) {
      for (const action of actions) {
        await expect(openPlatformAction(platform, action)).rejects.toThrow('Open the desktop app to view this platform.');
      }
    }
    expect(open).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects Kling website, developer, and generated-video actions in the browser', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await expect(openKling()).rejects.toThrow('Open the desktop app to view Kling.');
    await expect(openProviderKeys('kling')).rejects.toThrow('Open the desktop app to manage video sources.');
    await expect(openProviderSite('grok')).rejects.toThrow('Open the desktop app to manage video sources.');
    await expect(openVideo('source-1', 'task-1')).rejects.toThrow('Open the desktop app to manage video sources.');
    expect(open).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('dispatches desktop actions through the Rust commands', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    await openPlatformAction('youtube', 'post');
    await openKling();
    await openProviderKeys('kling');
    await openVideo('source-1', 'task-1');
    await openProviderSite('grok');
    expect(invoke).toHaveBeenNthCalledWith(1, 'open_platform_action', { platform: 'youtube', action: 'post' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'open_kling');
    expect(invoke).toHaveBeenNthCalledWith(3, 'open_video_provider_keys', { provider: 'kling' });
    expect(invoke).toHaveBeenNthCalledWith(4, 'open_video', { sourceId: 'source-1', taskId: 'task-1' });
    expect(invoke).toHaveBeenNthCalledWith(5, 'open_video_provider_site', { provider: 'grok' });
  });
});
