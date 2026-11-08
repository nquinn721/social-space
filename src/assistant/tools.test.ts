import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formFieldsFor, runTool, TOOL_SPECS, type ToolContext } from './tools';
import type { Account, Workspace } from '../model';
import * as profile from '../profileService';
import * as x from '../xService';
import * as email from '../emailService';
import * as kling from '../klingService';
import * as sources from '../videoSourcesService';

vi.mock('../profileService', async (original) => ({ ...(await original<typeof import('../profileService')>()), openPlatformWindow: vi.fn(), fillSiteForm: vi.fn(), chooseImageFile: vi.fn(), ensureAccountPassword: vi.fn() }));
vi.mock('../xService', () => ({ postToX: vi.fn() }));
vi.mock('../emailService', () => ({ listEmails: vi.fn(), readEmail: vi.fn() }));
vi.mock('../queueService', () => ({ listQueue: vi.fn() }));
vi.mock('../klingService', () => ({ generateKlingVideo: vi.fn() }));
vi.mock('../videoSourcesService', () => ({ listVideoSources: vi.fn() }));

const account: Account = { id: 'a1', platform: 'instagram', label: 'Studio', handle: 'studio', status: 'planned', notes: '', bio: 'Hello', signupEmail: 'me@example.com', imagePath: 'C:\\pics\\me.png' };
function context(workspace: Workspace, approve = true) {
  let current = workspace;
  const ctx: ToolContext & { current: () => Workspace } = {
    getWorkspace: () => current,
    saveWorkspace: vi.fn(async (next: Workspace) => { current = next; return next; }),
    navigate: vi.fn(),
    confirm: vi.fn(async () => approve),
    current: () => current,
  };
  return ctx;
}
const workspace = (): Workspace => ({ businessName: 'Example LLC', brands: [], accounts: [account], channels: [] });

beforeEach(() => vi.resetAllMocks());

describe('assistant tools', () => {
  it('generates Kling video with the named source, or the first verified one', async () => {
    vi.mocked(sources.listVideoSources).mockResolvedValue([
      { id: 'bad', name: 'Old', provider: 'kling', status: 'rejected', checkedAt: 1, creditsRemaining: null, detail: null },
      { id: 'new', name: 'Fresh', provider: 'kling', status: 'unchecked', checkedAt: null, creditsRemaining: null, detail: null },
      { id: 'main', name: 'Main', provider: 'kling', status: 'verified', checkedAt: 1, creditsRemaining: 10, detail: null },
    ]);
    vi.mocked(kling.generateKlingVideo).mockResolvedValue({ id: 't1', status: 'submitted', message: null, videoUrl: null });
    const ctx = context(workspace());
    expect(await runTool('generate_kling_video', { prompt: 'A city' }, ctx)).toMatchObject({ started: true, source: 'Main' });
    expect(kling.generateKlingVideo).toHaveBeenLastCalledWith('main', 'A city', '9:16', 5);
    await runTool('generate_kling_video', { prompt: 'A city', source: 'fresh' }, ctx);
    expect(kling.generateKlingVideo).toHaveBeenLastCalledWith('new', 'A city', '9:16', 5);
    await expect(runTool('generate_kling_video', { prompt: 'A city', source: 'Old' }, ctx)).rejects.toThrow('No Kling video source named Old');
  });


  it('declares every tool it can run, and none for passwords or submitting', () => {
    const names = TOOL_SPECS.map((tool) => tool.function.name);
    expect(names).toContain('fill_platform_form');
    expect(names.some((name) => /submit|password|captcha|signup_account/.test(name))).toBe(false);
  });

  it('adds a new account with a profile draft and enforces the platform bio limit', async () => {
    const ctx = context(workspace());
    const result = await runTool('save_account_profile', { platform: 'tiktok', displayName: 'Studio Clips', handle: '@clips', bio: 'Short clips daily' }, ctx);
    expect(ctx.current().accounts).toHaveLength(2);
    expect(ctx.current().accounts[1]).toMatchObject({ platform: 'tiktok', label: 'Studio Clips', handle: 'clips', bio: 'Short clips daily', status: 'planned' });
    expect(result.saved).toMatchObject({ bioLimit: 80, hasImage: false });
    await expect(runTool('save_account_profile', { platform: 'tiktok', label: 'x', bio: 'a'.repeat(81) }, ctx)).rejects.toThrow('allows 80');
  });

  it('updates an existing account without dropping its image or notes', async () => {
    const ctx = context(workspace());
    await runTool('save_account_profile', { accountId: 'a1', bio: 'New bio' }, ctx);
    expect(ctx.current().accounts[0]).toMatchObject({ id: 'a1', bio: 'New bio', imagePath: 'C:\\pics\\me.png', signupEmail: 'me@example.com' });
  });

  it('fills an open window from the saved profile and only attaches the image when asked', async () => {
    const ctx = context(workspace());
    await runTool('fill_platform_form', { windowId: 'site-3', accountId: 'a1', includeImage: true }, ctx);
    expect(profile.fillSiteForm).toHaveBeenCalledWith('site-3', { email: 'me@example.com', username: 'studio', fullName: 'Studio', displayName: 'Studio', bio: 'Hello' }, { imagePath: 'C:\\pics\\me.png', accountId: 'a1', includePassword: false, keepFilling: true });
    expect(profile.ensureAccountPassword).not.toHaveBeenCalled();
    await runTool('fill_platform_form', { windowId: 'site-3', accountId: 'a1', includePassword: true }, ctx);
    expect(profile.ensureAccountPassword).toHaveBeenCalledWith('a1');
    expect(vi.mocked(profile.fillSiteForm).mock.calls[1][2]).toMatchObject({ includePassword: true, accountId: 'a1' });
    expect(formFieldsFor(account, '123456').verificationCode).toBe('123456');
  });

  it('opens the sign-up page in an app window', async () => {
    vi.mocked(profile.openPlatformWindow).mockResolvedValue('site-9');
    await expect(runTool('open_platform_page', { platform: 'x', page: 'signup' }, context(workspace()))).resolves.toMatchObject({ windowId: 'site-9' });
    expect(profile.openPlatformWindow).toHaveBeenCalledWith('x', 'create');
  });

  it('asks before posting to X and respects a decline', async () => {
    const declined = context(workspace(), false);
    await expect(runTool('post_to_x', { text: 'Hello world' }, declined)).resolves.toMatchObject({ posted: false });
    expect(x.postToX).not.toHaveBeenCalled();
    vi.mocked(x.postToX).mockResolvedValue({ id: '1', text: 'Hello world' });
    const approved = context(workspace(), true);
    await expect(runTool('post_to_x', { text: 'Hello world' }, approved)).resolves.toMatchObject({ posted: true });
    expect(approved.confirm).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Hello world' }));
  });

  it('labels email bodies as untrusted', async () => {
    vi.mocked(email.readEmail).mockResolvedValue({ uid: 4, from: 'a', to: 'b', subject: 'Code', date: '', body: 'Your code is 1' });
    await expect(runTool('read_email', { uid: 4 }, context(workspace()))).resolves.toHaveProperty('untrustedEmail.body', 'Your code is 1');
  });
});
