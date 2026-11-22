import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoLibrary, { categoryProgress } from './VideoLibrary';
import { titleFromPrompt } from './useVideoGenerations';
import type { Account, Video, Workspace } from './model';
import * as sources from './videoSourcesService';
import * as videoIdeas from './assistant/videoIdeas';
vi.mock('./assistant/videoIdeas', async (original) => ({ ...(await original<typeof import('./assistant/videoIdeas')>()), suggestVideoIdeas: vi.fn() }));

vi.mock('./queueService', () => ({ chooseVideoFile: vi.fn() }));
vi.mock('./videoFileService', async (actual) => ({
  isLocalVideo: (await actual<typeof import('./videoFileService')>()).isLocalVideo,
  videoPreviewUrl: vi.fn(async () => 'http://asset.localhost/bunny.mp4'),
  openVideoFile: vi.fn(async () => {}),
  showVideoInFolder: vi.fn(async () => {}),
}));
import * as files from './videoFileService';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
let postingHandler: ((event: { payload: unknown }) => void) | undefined;
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { if (name !== 'posting-sign-in') postingHandler = handler; return () => {}; }) }));
vi.mock('./videoSourcesService', () => ({
  DESKTOP_ONLY: 'desktop only',
  listVideoSources: vi.fn(),
  generateVideo: vi.fn(),
  getVideo: vi.fn(),
  saveGeneratedVideo: vi.fn(),
}));
vi.mock('./instagramService', () => ({ claimInstagramConnection: vi.fn(async () => null), publishInstagramReelFile: vi.fn(), openInstagramPost: vi.fn(async () => {}) }));
import * as instagram from './instagramService';
// Every social posts through its brand window by default; "approving a post" switches Instagram and Facebook
// to API posting to keep that path working for when it is turned back on.
const postingApi = vi.hoisted(() => [] as string[]);
vi.mock('./postingMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./postingMode')>();
  return { ...actual, API_UPLOADS: postingApi, postMode: (platform: string) => postingApi.includes(platform) ? 'api' : 'browser' };
});
vi.mock('./assistant/postSuggest', () => ({ suggestPost: vi.fn(async () => { throw new Error('offline'); }), cachedPostSuggestion: vi.fn(async () => { throw new Error('offline'); }) }));
import * as ai from './assistant/postSuggest';
vi.mock('./VideoTextEditor', () => ({ default: ({ onSaved, onClose }: { onSaved: (path: string, edit: unknown) => Promise<boolean | undefined>; onClose: () => void }) => <div role="dialog" aria-label="Text editor">
  <button type="button" onClick={() => void onSaved('C:\\Videos\\Bunny hop with text.mp4', { sourcePath: 'C:\\clips\\bunny.mp4', sourceVideoId: 'v1', overlays: [{ id: 'o', text: 'Hop!', start: 0, end: 2, animation: 'pop', position: 'middle', size: 'medium', style: 'outline' }] }).then((ok) => { if (ok) onClose(); })}>Save stub</button></div> }));
const mocked = vi.mocked(sources);
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
beforeEach(() => { vi.clearAllMocks(); });

const profile = (id: string, platform: Account['platform'], status: Account['status'] = 'active'): Account => ({ id, platform, label: 'Mia', handle: 'mia', status, notes: '', brandId: 'mia' });
const bunny: Video = { id: 'v1', brandId: 'mia', categoryId: 'rabbit', title: 'Bunny hop', mediaSource: 'C:\\clips\\bunny.mp4', caption: '', posted: ['instagram'], createdAt: 1 };
const base: Workspace = {
  businessName: '', channels: [],
  brands: [{ id: 'mia', name: 'Massage With Mia', notes: '' }],
  accounts: [profile('1', 'instagram'), profile('2', 'tiktok'), profile('3', 'x', 'planned')],
  categories: [{ id: 'rabbit', brandId: 'mia', name: 'Rabbit' }],
  videos: [bunny],
};
const kling = { id: 'k1', name: 'Main Kling', provider: 'kling' as const, status: 'verified' as const, checkedAt: 1, creditsRemaining: null, detail: null };
function setup(workspace = base) {
  const onSave = vi.fn(async (_next: Workspace, _message: string) => true as boolean | undefined);
  const onOpen = vi.fn();
  const onManageSources = vi.fn();
  const onConnectInstagram = vi.fn();
  const view = render(<VideoLibrary workspace={workspace} loaded busy={false} onSave={onSave} onOpen={onOpen} onManageSources={onManageSources} onConnectInstagram={onConnectInstagram}/>);
  return { onSave, onOpen, onManageSources, onConnectInstagram, view, user: userEvent.setup() };
}

describe('video library', () => {
  it('never posts through a profile saved with the main Gmail', () => {
    const tiktok = { ...profile('2', 'tiktok'), signupEmail: 'SoftWings25@gmail.com' };
    setup({ ...base, accounts: [profile('1', 'instagram'), tiktok] });
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    expect(within(video).queryByRole('button', { name: /Post on TikTok/ })).not.toBeInTheDocument();
    expect(within(video).getByRole('button', { name: /Give it its own login \(TikTok\)/ })).toBeInTheDocument();
  });

  it('offers to create a profile instead of posting where the brand has none yet', async () => {
    const { user } = setup({ ...base, accounts: [profile('1', 'instagram'), profile('2', 'tiktok', 'planned')] });
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    expect(within(video).queryByRole('button', { name: /Post on TikTok/ })).not.toBeInTheDocument();
    expect(within(video).getByRole('button', { name: /Finish sign-up \(TikTok\)/ })).toBeInTheDocument();
    await user.click(within(video).getByRole('button', { name: /Edit post/ }));
    expect(within(video).getByText(/TikTok account isn't made yet/)).toBeInTheDocument();
  });

  it('posts on TikTok through its page, and asks when the window closes without posting', async () => {
    const { onSave, user } = setup();
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(video).getByRole('button', { name: /Post on TikTok/ }));
    expect(invoke).toHaveBeenCalledWith('open_posting_window', expect.anything());
    await act(async () => { postingHandler?.({ payload: { videoId: 'v1', platform: 'tiktok', state: 'closed', posted: false } }); });
    expect(within(video).getByText('Did it go up?')).toBeInTheDocument();
    await user.click(within(video).getByRole('button', { name: /Yes, it's on TikTok/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: ['instagram', 'tiktok'] })] }), 'Marked "Bunny hop" as posted on TikTok.');
  });

  it('keeps the confirmation visible with an error when saving a posted mark fails', async () => {
    const { onSave, user } = setup();
    onSave.mockResolvedValue(false);
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    await act(async () => { postingHandler?.({ payload: { videoId: 'v1', platform: 'tiktok', state: 'closed', posted: false } }); });
    await user.click(within(video).getByRole('button', { name: /Yes, it's on TikTok/ }));
    expect(await within(video).findByRole('alert')).toBeVisible();
    expect(within(video).getByRole('button', { name: /Yes, it's on TikTok/ })).toBeEnabled();
  });

  it('marks it posted by itself when the page shows the post went up', async () => {
    const { onSave } = setup();
    await act(async () => { postingHandler?.({ payload: { videoId: 'v1', platform: 'tiktok', state: 'posted', posted: true } }); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: ['instagram', 'tiktok'] })] }), 'Marked "Bunny hop" as posted on TikTok.');
  });

  it('offers manual X caption and file helpers without marking the post as published', async () => {
    const x = { ...profile('x1', 'x'), signupEmail: 'brand@example.com' };
    const { onSave, user } = setup({ ...base, accounts: [x], videos: [{ ...bunny, posted: [], caption: 'A brand caption' }] });
    const row = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(row).getByRole('button', { name: 'Copy X caption' }));
    expect(await navigator.clipboard.readText()).toBe('A brand caption');
    await user.click(within(row).getByRole('button', { name: 'Show X video in folder' }));
    expect(files.showVideoInFolder).toHaveBeenCalledWith(bunny.mediaSource);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('counts videos per category and how many are on every social', () => {
    expect(categoryProgress(base.videos!, ['instagram'])).toEqual({ total: 1, everywhere: 1 });
    expect(categoryProgress(base.videos!, ['instagram', 'tiktok'])).toEqual({ total: 1, everywhere: 0 });
    setup();
    expect(screen.getByRole('button', { name: 'Rabbit 1' })).toHaveAttribute('aria-pressed', 'true');
    // Only the socials the brand has a profile on get a tile: no Facebook without a Facebook account.
    expect(screen.getByText('1 video · 2 posts to make')).toBeInTheDocument();
  });

  it("shows where a video is up, never marks one posted from a logo, and unmarks after asking", async () => {
    const { onSave, onOpen, user } = setup();
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    expect(within(video).getByText('Posted on 1 of 3')).toBeInTheDocument();
    expect(within(video).queryByText('Facebook')).not.toBeInTheDocument();
    expect(within(video).getByRole('group', { name: 'Where it goes' })).toHaveTextContent('TikTok');
    expect(within(video).queryByRole('button', { name: 'TikTok' })).not.toBeInTheDocument();
    await user.click(within(video).getByRole('button', { name: /Edit post/ }));
    await user.click(within(video).getByRole('button', { name: /Post on TikTok/ }));
    expect(invoke).toHaveBeenCalledWith('open_posting_window', { request: expect.objectContaining({ platform: 'tiktok', brandId: 'mia', videoId: 'v1', accountId: '2', handle: 'mia', videoPath: 'C:\\clips\\bunny.mp4' }) });
    expect(onOpen).not.toHaveBeenCalled();
    onSave.mockClear();
    await user.click(within(video).getByRole('button', { name: 'Mark as not posted on Instagram' }));
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Mark as not posted' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: [] })] }), 'Marked "Bunny hop" as not posted on Instagram.');
  });


  it('keeps the add forms hidden until asked, then adds a category and a video', async () => {
    const { onSave, user } = setup();
    expect(screen.queryByLabelText('Category name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New category' }));
    await user.type(screen.getByLabelText('Category name'), 'Cats');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ categories: [base.categories![0], expect.objectContaining({ brandId: 'mia', name: 'Cats' })] }), 'Added the Cats category.');
    await user.click(screen.getByRole('button', { name: /Add a file/ }));
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Rabbit nap');
    await user.click(screen.getByRole('button', { name: /Add a description/ }));
    await user.type(screen.getByLabelText('Description'), 'So sleepy');
    await user.click(screen.getByRole('button', { name: 'Add video' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ videos: [bunny, expect.objectContaining({ title: 'Rabbit nap', caption: 'So sleepy', posted: [] })] }), 'Added "Rabbit nap" to Rabbit.');
  });

  it('makes a video with a source and adds it to the category as being made', async () => {
    mocked.listVideoSources.mockResolvedValue({ active: 'k1', sources: [kling] });
    mocked.generateVideo.mockResolvedValue({ id: 'task-1', status: 'submitted', message: null, videoUrl: null, sourceId: 'k1', sourceName: 'Main Kling', provider: 'kling' });
    mocked.getVideo.mockResolvedValue({ id: 'task-1', status: 'processing', message: null, videoUrl: null });
    const { onSave, user } = setup();
    await user.click(screen.getByRole('button', { name: /Make a video/ }));
    await user.type(await screen.findByLabelText('Describe the video'), 'A white rabbit hops through a sunny garden');
    expect(screen.getByLabelText('Made with')).toHaveValue('k1');
    await user.click(screen.getByRole('button', { name: 'Make video' }));
    expect(mocked.generateVideo).toHaveBeenCalledWith('k1', 'A white rabbit hops through a sunny garden', '9:16', 5, undefined);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [bunny, expect.objectContaining({ title: 'A white rabbit hops through a sunny garden', categoryId: 'rabbit', generation: expect.objectContaining({ taskId: 'task-1', sourceId: 'k1', status: 'working' }) })] }), expect.stringContaining('Main Kling is making'));
  });

  it('lets the user reroll suggestions and use a complete scene without starting a video', async () => {
    mocked.listVideoSources.mockResolvedValue({ active: 'k1', sources: [kling] });
    mocked.generateVideo.mockResolvedValue({ id: 'task-idea', status: 'submitted', message: null, videoUrl: null, sourceId: 'k1', sourceName: 'Main Kling', provider: 'kling' });
    const ideas = Array.from({ length: 5 }, (_, index) => ({ title: `Idea ${index + 1}`, description: 'A short story.', scenes: [{ prompt: `First scene ${index}`, seconds: 5 }, { prompt: `Second scene ${index}`, seconds: 10 }] }));
    vi.mocked(videoIdeas.suggestVideoIdeas).mockResolvedValueOnce(ideas).mockResolvedValueOnce([{ title: 'Fresh idea', description: 'Something new.', scenes: [{ prompt: 'A new prompt', seconds: 5 }] }]);
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Make a video/ }));
    await user.click(await screen.findByRole('button', { name: 'Suggest video prompts' }));
    const dialog = await screen.findByRole('dialog', { name: 'Video ideas for your brand' });
    expect(within(dialog).getAllByText(/separate clips/)).toHaveLength(5);
    await user.click(within(dialog).getByRole('button', { name: 'Reroll video idea 1' }));
    expect(await within(dialog).findByText('Fresh idea')).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole('button', { name: 'Use scene 2' })[0]);
    expect(screen.getByLabelText('Describe the video')).toHaveValue('Second scene 1');
    expect(screen.getByLabelText('Length')).toHaveValue('10');
    expect(mocked.generateVideo).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Make video' }));
    expect(await screen.findByText(/Clip started/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View video ideas' }));
    expect(await screen.findByRole('dialog', { name: 'Video ideas for your brand' })).toHaveTextContent('Second scene 1');
    expect(videoIdeas.suggestVideoIdeas).toHaveBeenCalledTimes(2);
  });

  it('points to Video sources when none is connected', async () => {
    mocked.listVideoSources.mockResolvedValue({ active: null, sources: [] });
    const { onManageSources, user } = setup();
    await user.click(screen.getByRole('button', { name: /Make a video/ }));
    await user.click(await screen.findByRole('button', { name: 'Set up video sources' }));
    expect(onManageSources).toHaveBeenCalled();
  });

  it('saves a finished video into the category and records a failed one', async () => {
    const making: Video = { ...bunny, id: 'v2', title: 'Rabbit ai', mediaSource: '', posted: [], createdAt: 2, generation: { sourceId: 'k1', sourceName: 'Main Kling', provider: 'kling', taskId: 'task-1', prompt: 'rabbit', status: 'working' } };
    mocked.getVideo.mockResolvedValue({ id: 'task-1', status: 'succeeded', message: null, videoUrl: 'https://cdn.example.com/v.mp4' });
    mocked.saveGeneratedVideo.mockResolvedValue('C:\\Users\\me\\Videos\\SocialSpace\\Massage With Mia\\Rabbit\\Rabbit ai.mp4');
    const { onSave } = setup({ ...base, videos: [bunny, making] });
    expect(screen.getByRole('listitem', { name: 'Rabbit ai' })).toHaveTextContent('Being made by Main Kling');
    await act(async () => {});
    expect(mocked.saveGeneratedVideo).toHaveBeenCalledWith('k1', 'task-1', 'Massage With Mia', 'Rabbit', 'Rabbit ai');
    const saved = onSave.mock.calls[0][0].videos!.find((video) => video.id === 'v2')!;
    expect(saved.mediaSource).toMatch(/Rabbit ai\.mp4$/);
    expect(saved.generation).toBeUndefined();

    cleanup(); onSave.mockClear();
    mocked.getVideo.mockResolvedValue({ id: 'task-1', status: 'failed', message: 'Out of credits', videoUrl: null });
    const second = setup({ ...base, videos: [bunny, making] });
    await act(async () => {});
    expect(second.onSave.mock.calls[0][0].videos!.find((video) => video.id === 'v2')!.generation).toMatchObject({ status: 'failed', message: 'Out of credits' });
  });

  it('plays a saved video in the library and opens it in the player or its folder', async () => {
    const { user } = setup();
    const row = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(row).getByRole('button', { name: 'Play Bunny hop' }));
    expect(files.videoPreviewUrl).toHaveBeenCalledWith(bunny.mediaSource);
    expect(await within(row).findByLabelText('Bunny hop', { selector: 'video' })).toHaveAttribute('src', 'http://asset.localhost/bunny.mp4');
    await user.click(within(row).getByRole('button', { name: /Open in player/ }));
    expect(files.openVideoFile).toHaveBeenCalledWith(bunny.mediaSource);
    await user.click(within(row).getByRole('button', { name: /Show in folder/ }));
    expect(files.showVideoInFolder).toHaveBeenCalledWith(bunny.mediaSource);
    await user.click(within(row).getByRole('button', { name: 'Hide Bunny hop' }));
    expect(within(row).queryByLabelText('Bunny hop', { selector: 'video' })).not.toBeInTheDocument();
  });

  it('adds text to a video and saves it as a new video in the category, keeping the original', async () => {
    const { onSave, user } = setup({ ...base, videos: [{ ...bunny, caption: 'Hop hop', prompt: 'a bunny hops' }] });
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(video).getByRole('button', { name: /Add text/ }));
    await user.click(screen.getByRole('button', { name: 'Save stub' }));
    const [next, message] = onSave.mock.calls[0];
    expect(message).toBe('Saved "Bunny hop with text" in Rabbit.');
    expect(next.videos).toHaveLength(2);
    expect(next.videos?.[1]).toMatchObject({ title: 'Bunny hop with text', mediaSource: 'C:\\Videos\\Bunny hop with text.mp4', categoryId: 'rabbit', caption: 'Hop hop', prompt: 'a bunny hops', posted: [], textEdit: { sourceVideoId: 'v1' } });
    expect(screen.queryByRole('dialog', { name: 'Text editor' })).not.toBeInTheDocument();
  });

  it('changes the text of a text video in place while it is not posted anywhere', async () => {
    const withText: Video = { ...bunny, id: 't1', title: 'Bunny hop with text', posted: [], textEdit: { sourcePath: 'C:\\clips\\bunny.mp4', sourceVideoId: 'v1', overlays: [] } };
    const { onSave, user } = setup({ ...base, videos: [withText] });
    const video = screen.getByRole('listitem', { name: 'Bunny hop with text' });
    await user.click(within(video).getByRole('button', { name: /Edit text/ }));
    await user.click(screen.getByRole('button', { name: 'Save stub' }));
    const [next] = onSave.mock.calls[0];
    expect(next.videos).toHaveLength(1);
    expect(next.videos?.[0]).toMatchObject({ id: 't1', mediaSource: 'C:\\Videos\\Bunny hop with text.mp4' });
  });

  it('shortens long prompts into a title', () => {
    expect(titleFromPrompt('  A rabbit  ')).toBe('A rabbit');
    const title = titleFromPrompt('A fluffy white rabbit hops slowly through a sunny spring garden full of bright tulips and daisies');
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('posting to standalone Instagram and Facebook accounts', () => {
  it('opens Instagram and Facebook in the brand window, like TikTok, with no Meta connection', async () => {
    const fresh: Video = { ...bunny, id: 'v3', title: 'Hay day', mediaSource: 'C:\\clips\\hay.mp4', caption: 'Hay', posted: [] };
    const own = (id: string, platform: Account['platform']) => ({ ...profile(id, platform), signupEmail: `softwings25+mia@gmail.com` });
    const { user } = setup({ ...base, accounts: [own('1', 'instagram'), own('4', 'facebook')], videos: [fresh] });
    const row = screen.getByRole('listitem', { name: 'Hay day' });
    expect(within(row).queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Post on Instagram' }));
    expect(invoke).toHaveBeenCalledWith('open_posting_window', { request: expect.objectContaining({ platform: 'instagram', brandId: 'mia', accountId: '1', email: 'softwings25+mia@gmail.com', videoPath: 'C:\\clips\\hay.mp4' }) });
    await user.click(within(row).getByRole('button', { name: 'Post on Facebook' }));
    expect(invoke).toHaveBeenCalledWith('open_posting_window', { request: expect.objectContaining({ platform: 'facebook', accountId: '4', email: 'softwings25+mia@gmail.com' }) });
    expect(instagram.publishInstagramReelFile).not.toHaveBeenCalled();
  });
});

describe('approving a post', () => {
  beforeEach(() => { postingApi.splice(0, postingApi.length, 'instagram', 'facebook'); });
  afterEach(() => { postingApi.splice(0); });
  const fresh: Video = { ...bunny, id: 'v2', title: 'Carrot crunch', mediaSource: 'C:\\clips\\carrot.mp4', caption: 'Crunchy', posted: [] };
  const workspace = { ...base, videos: [fresh] };
  const connected = () => vi.mocked(instagram.claimInstagramConnection).mockResolvedValue({ id: '178', username: 'mia', login: 'facebook' });

  it('prepares browser windows without sending or marking Meta posts', async () => {
    connected();
    const { onSave, user } = setup(workspace);
    const row = screen.getByRole('listitem', { name: 'Carrot crunch' });
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Post to Instagram' })).toBeEnabled());
    await user.click(within(row).getByRole('button', { name: 'Prepare posting windows' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('separate Instagram Post');
    expect(dialog).toHaveTextContent('TikTok: Opens the upload page; you review and publish');
    await user.click(within(dialog).getByRole('button', { name: 'Open posting windows' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_posting_window', expect.objectContaining({ request: expect.objectContaining({ platform: 'tiktok' }) })));
    expect(instagram.publishInstagramReelFile).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses a changed account after the plan was reviewed', async () => {
    connected();
    const { view, onSave, onOpen, onManageSources, onConnectInstagram, user } = setup(workspace);
    const row = screen.getByRole('listitem', { name: 'Carrot crunch' });
    await user.click(within(row).getByRole('button', { name: 'Prepare posting windows' }));
    const dialog = await screen.findByRole('alertdialog');
    const changed = { ...workspace, accounts: workspace.accounts.map(account => account.platform === 'tiktok' ? { ...account, handle: 'replacement' } : account) };
    view.rerender(<VideoLibrary workspace={changed} loaded busy={false} onSave={onSave} onOpen={onOpen} onManageSources={onManageSources} onConnectInstagram={onConnectInstagram}/>);
    await user.click(within(dialog).getByRole('button', { name: 'Open posting windows' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('account changed');
    expect(invoke).not.toHaveBeenCalledWith('open_posting_window', expect.anything());
  });

  it('shows the whole post and posts it to Instagram when approved', async () => {
    connected();
    vi.mocked(instagram.publishInstagramReelFile).mockResolvedValue({ id: 'reel-1', permalink: 'https://www.instagram.com/reel/abc/' });
    const confirmBox = vi.spyOn(window, 'confirm');
    const { onSave, user } = setup(workspace);
    const row = screen.getByRole('listitem', { name: 'Carrot crunch' });
    expect(within(row).getByText('Ready to post')).toBeInTheDocument();
    expect(within(row).getByLabelText('Post')).toHaveTextContent('Crunchy');
    await user.click(await within(row).findByRole('button', { name: 'Post to Instagram' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('@mia');
    await user.click(within(dialog).getByRole('button', { name: 'Post to Instagram' }));
    expect(confirmBox).not.toHaveBeenCalled();
    expect(instagram.claimInstagramConnection).toHaveBeenCalledWith('1', 'mia');
    expect(instagram.publishInstagramReelFile).toHaveBeenCalledWith('C:\\clips\\carrot.mp4', 'Crunchy', '1', { coverMs: undefined, shareToFeed: true, expectedId: '178' });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ id: 'v2', posted: ['instagram'], links: { instagram: 'https://www.instagram.com/reel/abc/' } })] }), 'Posted "Carrot crunch" to @mia on Instagram.');
  });

  it('keeps a published result for review when saving fails and blocks a duplicate after reopening', async () => {
    connected();
    vi.mocked(instagram.publishInstagramReelFile).mockResolvedValue({ id: 'reel-1', permalink: 'https://www.instagram.com/reel/abc/' });
    const { onSave, user, view, onOpen, onManageSources, onConnectInstagram } = setup(workspace);
    onSave.mockResolvedValue(false);
    await user.click(await screen.findByRole('button', { name: 'Post to Instagram' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post to Instagram' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Published on Instagram');
    expect(screen.getByRole('button', { name: 'Mark posted' })).toBeInTheDocument();
    view.unmount();
    render(<VideoLibrary workspace={workspace} loaded busy={false} onSave={onSave} onOpen={onOpen} onManageSources={onManageSources} onConnectInstagram={onConnectInstagram}/>);
    expect(screen.queryByRole('button', { name: 'Post to Instagram' })).not.toBeInTheDocument();
    onSave.mockResolvedValue(true);
    await user.click(screen.getByRole('button', { name: 'Mark posted' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Mark posted' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: ['instagram'], links: { instagram: 'https://www.instagram.com/reel/abc/' } })] }), expect.any(String));
    expect(instagram.publishInstagramReelFile).toHaveBeenCalledTimes(1);
  });

  it('preserves other workspace edits made while a post is uploading', async () => {
    connected();
    let finish!: (value: { id: string }) => void;
    vi.mocked(instagram.publishInstagramReelFile).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { onSave, user, view, onOpen, onManageSources, onConnectInstagram } = setup(workspace);
    await user.click(await screen.findByRole('button', { name: 'Post to Instagram' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post to Instagram' }));
    const changed = { ...workspace, businessName: 'New name', videos: [{ ...fresh, caption: 'Edited while uploading' }] };
    view.rerender(<VideoLibrary workspace={changed} loaded busy={false} onSave={onSave} onOpen={onOpen} onManageSources={onManageSources} onConnectInstagram={onConnectInstagram}/>);
    await act(async () => finish({ id: 'reel-1' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'New name', videos: [expect.objectContaining({ caption: 'Edited while uploading', posted: ['instagram'] })] }), expect.any(String));
  });

  it('opens the live post from a posted video', async () => {
    connected();
    const live: Video = { ...fresh, posted: ['instagram'], links: { instagram: 'https://www.instagram.com/reel/abc/' } };
    const { user } = setup({ ...base, videos: [live] });
    const row = screen.getByRole('listitem', { name: 'Carrot crunch' });
    await user.click(within(row).getByRole('button', { name: 'View on Instagram' }));
    expect(instagram.openInstagramPost).toHaveBeenCalledTimes(1);
    expect(instagram.openInstagramPost).toHaveBeenCalledWith('https://www.instagram.com/reel/abc/');
  });

  it('does nothing when the confirmation is cancelled', async () => {
    connected();
    const { onSave, user } = setup(workspace);
    await user.click(await screen.findByRole('button', { name: 'Post to Instagram' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(instagram.publishInstagramReelFile).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the Instagram error and keeps the video unposted', async () => {
    connected();
    vi.mocked(instagram.publishInstagramReelFile).mockRejectedValue('Instagram refused the video upload (HTTP 400).');
    const { onSave, user } = setup(workspace);
    await user.click(await screen.findByRole('button', { name: 'Post to Instagram' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post to Instagram' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 400');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('asks to connect Instagram instead of opening the site when the profile is not connected', async () => {
    vi.mocked(instagram.claimInstagramConnection).mockResolvedValue(null);
    const { onConnectInstagram, onOpen, user } = setup(workspace);
    await user.click(await screen.findByRole('button', { name: /Connect Instagram \(Instagram\)/ }));
    expect(onConnectInstagram).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Post to Instagram' })).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('posts with the edited hashtags, cover and feed choice, and saves them as the category defaults', async () => {
    connected();
    vi.mocked(instagram.publishInstagramReelFile).mockResolvedValue({ id: 'reel-1' });
    const detailed: Video = { ...fresh, details: { hashtags: ['bunny'], youtubeTitle: '', coverMs: 2500, madeWithAi: true, shareToFeed: true, madeForKids: false } };
    const { onSave, user } = setup({ ...base, videos: [detailed] });
    const row = screen.getByRole('listitem', { name: 'Carrot crunch' });
    await user.click(within(row).getByRole('button', { name: /Edit post/ }));
    await user.type(within(row).getByLabelText('Hashtags'), ' snow');
    await user.click(within(row).getByLabelText(/main feed/));
    expect(within(row).getByLabelText(/Start new Rabbit videos/)).toBeChecked();
    await user.click(await within(row).findByRole('button', { name: 'Post to Instagram' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Crunchy #bunny #snow');
    await user.click(within(dialog).getByRole('button', { name: 'Post to Instagram' }));
    expect(instagram.publishInstagramReelFile).toHaveBeenCalledWith(fresh.mediaSource, 'Crunchy\n\n#bunny #snow', '1', { coverMs: 2500, shareToFeed: false, expectedId: '178' });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ categories: [expect.objectContaining({ id: 'rabbit', defaults: { caption: 'Crunchy', hashtags: ['bunny', 'snow'] } })] }), expect.any(String));
  });
});

describe('post details', () => {
  it('starts a new video with its category defaults', async () => {
    const withDefaults: Workspace = { ...base, categories: [{ id: 'rabbit', brandId: 'mia', name: 'Rabbit', defaults: { caption: 'Hop hop', hashtags: ['bunny'] } }] };
    const { onSave, user } = setup(withDefaults);
    await user.click(screen.getByRole('button', { name: /Add a file/ }));
    await user.type(screen.getByLabelText('Title'), 'Rabbit nap');
    await user.click(screen.getByRole('button', { name: 'Add video' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ videos: [bunny, expect.objectContaining({ title: 'Rabbit nap', caption: 'Hop hop', details: expect.objectContaining({ hashtags: ['bunny'] }) })] }), expect.any(String));
  });

  it('writes the post with AI on request', async () => {
    vi.mocked(ai.suggestPost).mockResolvedValueOnce({ description: 'Snow day for this bunny', hashtags: ['bunny', 'snow'] });
    const { user } = setup({ ...base, videos: [{ ...bunny, caption: 'x' }] });
    const row = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(row).getByRole('button', { name: /Edit post/ }));
    await user.click(within(row).getByRole('button', { name: /Suggest with AI/ }));
    expect(ai.suggestPost).toHaveBeenCalledWith(expect.objectContaining({ brand: 'Massage With Mia', category: 'Rabbit', title: 'Bunny hop' }));
    expect(within(row).getByLabelText('Description')).toHaveValue('Snow day for this bunny');
    expect(within(row).getByLabelText('Hashtags')).toHaveValue('#bunny #snow');
  });

  it('shows the Grok suggestion in grey in an empty description, and Tab takes it', async () => {
    vi.mocked(ai.cachedPostSuggestion).mockResolvedValueOnce({ description: 'Snow day for this bunny', hashtags: ['bunny', 'snow'] });
    const { user } = setup({ ...base, videos: [{ ...bunny, caption: '' }] });
    const row = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(row).getByRole('button', { name: /Edit post/ }));
    const description = within(row).getByLabelText('Description');
    await waitFor(() => expect(description).toHaveAttribute('placeholder', 'Snow day for this bunny'));
    expect(description).toHaveValue('');
    description.focus();
    await user.keyboard('{Tab}');
    expect(description).toHaveValue('Snow day for this bunny');
    const hashtags = within(row).getByLabelText('Hashtags');
    expect(hashtags).toHaveAttribute('placeholder', '#bunny #snow');
    await user.type(hashtags, '#mine');
    expect(hashtags).toHaveValue('#mine');
  });

  it('fills in a new post with AI by itself', async () => {
    vi.mocked(ai.suggestPost).mockResolvedValueOnce({ description: 'Hoppy', hashtags: ['bunny'] });
    const { onSave } = setup();
    await act(async () => {});
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ id: 'v1', caption: 'Hoppy', details: expect.objectContaining({ hashtags: ['bunny'] }) })] }), 'Wrote the post for "Bunny hop". Check it and approve it to post.');
  });

  it('saves the description, hashtags, YouTube title and labels', async () => {
    const withYoutube: Workspace = { ...base, accounts: [...base.accounts, profile('4', 'youtube')] };
    const { onSave, user } = setup(withYoutube);
    const row = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(row).getByRole('button', { name: /Edit post/ }));
    await user.type(within(row).getByLabelText('Description'), 'Snow day');
    await user.type(within(row).getByLabelText('Hashtags'), 'bunny, #Snow bunny');
    expect(within(row).getByLabelText('YouTube title')).toHaveValue('Bunny hop');
    await user.click(within(row).getByLabelText(/Made with AI/));
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ caption: 'Snow day', details: expect.objectContaining({ hashtags: ['bunny', 'Snow'], youtubeTitle: 'Bunny hop', madeWithAi: true, shareToFeed: true }) })] }), 'Saved the post details of "Bunny hop".');
  });

  it('blocks saving when X would get more than 280 characters', async () => {
    const withX: Workspace = { ...base, accounts: [profile('1', 'instagram'), profile('3', 'x')] };
    const { user } = setup(withX);
    const row = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(row).getByRole('button', { name: /Edit post/ }));
    await user.click(within(row).getByLabelText('Description'));
    await user.paste('a'.repeat(281));
    expect(within(row).getByRole('alert')).toHaveTextContent('X post is 281 characters');
    expect(within(row).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('content stages', () => {
  it('filters posts by stage', async () => {
    const review: Video = { ...bunny, id: 'v3', title: 'Hop review', posted: [], createdAt: 3 };
    const bunnyEverywhere = { ...bunny, posted: ['instagram', 'facebook'] as Video['posted'] };
    const { user } = setup({ ...base, accounts: [profile('1', 'instagram')], videos: [bunnyEverywhere, review] });
    await user.click(screen.getByRole('button', { name: 'To post 1' }));
    expect(screen.getByRole('listitem', { name: 'Hop review' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Bunny hop' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Posted 1' }));
    expect(screen.getByRole('listitem', { name: 'Bunny hop' })).toBeInTheDocument();
  });

  it('labels series parts and holds a part back on a social until the part before it is up', () => {
    const story = { id: 's', brandId: 'mia', categoryId: 'rabbit', title: 'Knots', premise: '', bible: '', characters: [], episodes: [1, 2].map((number) => ({ id: `e${number}`, number, title: '', summary: '' })), aspectRatio: '9:16', duration: 10, createdAt: 1 };
    const one: Video = { ...bunny, id: 'p1', title: 'Knots: Part 1 of 2', posted: ['instagram'], seriesId: 's', episode: 1 };
    const two: Video = { ...bunny, id: 'p2', title: 'Knots: Part 2 of 2', posted: [], seriesId: 's', episode: 2, createdAt: 2 };
    setup({ ...base, accounts: [profile('1', 'instagram'), profile('2', 'tiktok')], videos: [one, two], series: [story] });
    const second = screen.getByRole('listitem', { name: 'Knots: Part 2 of 2' });
    expect(within(second).getByText('Part 2 of 2')).toBeInTheDocument();
    const tiles = within(second).getByRole('group', { name: 'Where it goes' });
    expect(within(tiles).getAllByText('After Part 1').length).toBeGreaterThan(0);
    expect(within(tiles).queryByRole('button', { name: 'Post on TikTok' })).not.toBeInTheDocument();
  });
});
