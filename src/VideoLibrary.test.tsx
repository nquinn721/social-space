import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoLibrary, { categoryProgress } from './VideoLibrary';
import { titleFromPrompt } from './useVideoGenerations';
import type { Account, Video, Workspace } from './model';
import * as sources from './videoSourcesService';

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
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => { postingHandler = handler; return () => {}; }) }));
vi.mock('./videoSourcesService', () => ({
  DESKTOP_ONLY: 'desktop only',
  listVideoSources: vi.fn(),
  generateVideo: vi.fn(),
  getVideo: vi.fn(),
  saveGeneratedVideo: vi.fn(),
}));
vi.mock('./instagramService', () => ({ claimInstagramConnection: vi.fn(async () => null), publishInstagramReelFile: vi.fn(), openInstagramPost: vi.fn(async () => {}) }));
import * as instagram from './instagramService';
vi.mock('./assistant/postSuggest', () => ({ suggestPost: vi.fn(async () => { throw new Error('offline'); }) }));
import * as ai from './assistant/postSuggest';
const mocked = vi.mocked(sources);
afterEach(() => { cleanup(); vi.useRealTimers(); });
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
    expect(within(video).getByRole('button', { name: /own TikTok login/ })).toBeInTheDocument();
  });

  it('offers to create a profile instead of posting where the brand has none yet', async () => {
    const { user } = setup({ ...base, accounts: [profile('1', 'instagram'), profile('2', 'tiktok', 'planned')] });
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    expect(within(video).queryByRole('button', { name: /Post on TikTok/ })).not.toBeInTheDocument();
    expect(within(video).getByRole('button', { name: /Create TikTok profile/ })).toBeInTheDocument();
    await user.click(within(video).getByRole('button', { name: /Edit post/ }));
    expect(within(video).getByText(/has no TikTok profile of its own yet/)).toBeInTheDocument();
  });

  it('posts on TikTok through its page, and asks when the window closes without posting', async () => {
    const { onSave, user } = setup();
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    await user.click(within(video).getByRole('button', { name: /Post on TikTok/ }));
    expect(invoke).toHaveBeenCalledWith('open_posting_window', expect.anything());
    await act(async () => { postingHandler?.({ payload: { videoId: 'v1', platform: 'tiktok', state: 'closed', posted: false } }); });
    expect(within(video).getByText(/Did "Bunny hop" go up on TikTok/)).toBeInTheDocument();
    await user.click(within(video).getByRole('button', { name: /Yes, mark posted/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: ['instagram', 'tiktok'] })] }), 'Marked "Bunny hop" as posted on TikTok.');
  });

  it('marks it posted by itself when the page shows the post went up', async () => {
    const { onSave } = setup();
    await act(async () => { postingHandler?.({ payload: { videoId: 'v1', platform: 'tiktok', state: 'posted', posted: true } }); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: ['instagram', 'tiktok'] })] }), 'Marked "Bunny hop" as posted on TikTok.');
  });

  it('counts videos per category and how many are on every social', () => {
    expect(categoryProgress(base.videos!, ['instagram'])).toEqual({ total: 1, everywhere: 1 });
    expect(categoryProgress(base.videos!, ['instagram', 'tiktok'])).toEqual({ total: 1, everywhere: 0 });
    setup();
    expect(screen.getByRole('button', { name: 'Rabbit 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 video · 0 on every social')).toBeInTheDocument();
  });

  it("shows where a video is up, never marks one posted from a logo, and unmarks after asking", async () => {
    const { onSave, onOpen, user } = setup();
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    expect(within(video).getByText('bunny.mp4 · 1 of 3 socials')).toBeInTheDocument();
    expect(within(video).getByRole('img', { name: 'Not posted on TikTok yet' })).toBeInTheDocument();
    expect(within(video).queryByRole('button', { name: 'TikTok' })).not.toBeInTheDocument();
    await user.click(within(video).getByRole('img', { name: 'Not posted on TikTok yet' }));
    expect(onSave).not.toHaveBeenCalled();
    await user.click(within(video).getByRole('button', { name: /Edit post/ }));
    await user.click(within(video).getByRole('button', { name: /Post on TikTok/ }));
    expect(invoke).toHaveBeenCalledWith('open_posting_window', { request: expect.objectContaining({ platform: 'tiktok', brandId: 'mia', videoId: 'v1', accountId: '2', handle: 'mia', videoPath: 'C:\\clips\\bunny.mp4' }) });
    expect(onOpen).not.toHaveBeenCalled();
    onSave.mockClear();
    await user.click(within(video).getByRole('button', { name: 'Posted on Instagram' }));
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
    expect(mocked.generateVideo).toHaveBeenCalledWith('k1', 'A white rabbit hops through a sunny garden', '9:16', 5);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [bunny, expect.objectContaining({ title: 'A white rabbit hops through a sunny garden', categoryId: 'rabbit', generation: expect.objectContaining({ taskId: 'task-1', sourceId: 'k1', status: 'working' }) })] }), expect.stringContaining('Main Kling is making'));
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

  it('shortens long prompts into a title', () => {
    expect(titleFromPrompt('  A rabbit  ')).toBe('A rabbit');
    const title = titleFromPrompt('A fluffy white rabbit hops slowly through a sunny spring garden full of bright tulips and daisies');
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('approving a post', () => {
  const fresh: Video = { ...bunny, id: 'v2', title: 'Carrot crunch', mediaSource: 'C:\\clips\\carrot.mp4', caption: 'Crunchy', posted: [] };
  const workspace = { ...base, videos: [fresh] };
  const connected = () => vi.mocked(instagram.claimInstagramConnection).mockResolvedValue({ id: '178', username: 'animals', login: 'facebook' });

  it('shows the whole post and posts it to Instagram when approved', async () => {
    connected();
    vi.mocked(instagram.publishInstagramReelFile).mockResolvedValue({ id: 'reel-1', permalink: 'https://www.instagram.com/reel/abc/' });
    const confirmBox = vi.spyOn(window, 'confirm');
    const { onSave, user } = setup(workspace);
    const row = screen.getByRole('listitem', { name: 'Carrot crunch' });
    expect(within(row).getByText('To approve')).toBeInTheDocument();
    expect(within(row).getByLabelText('Post')).toHaveTextContent('Crunchy');
    await user.click(await within(row).findByRole('button', { name: /Approve and post/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('@animals');
    await user.click(within(dialog).getByRole('button', { name: 'Post to Instagram' }));
    expect(confirmBox).not.toHaveBeenCalled();
    expect(instagram.claimInstagramConnection).toHaveBeenCalledWith('1', 'mia');
    expect(instagram.publishInstagramReelFile).toHaveBeenCalledWith('C:\\clips\\carrot.mp4', 'Crunchy', '1', { coverMs: undefined, shareToFeed: true });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ id: 'v2', posted: ['instagram'], links: { instagram: 'https://www.instagram.com/reel/abc/' } })] }), 'Posted "Carrot crunch" to @animals on Instagram.');
  });

  it('opens the live post from a posted video', async () => {
    connected();
    const live: Video = { ...fresh, posted: ['instagram'], links: { instagram: 'https://www.instagram.com/reel/abc/' } };
    const { user } = setup({ ...base, videos: [live] });
    const row = screen.getByRole('listitem', { name: 'Carrot crunch' });
    await user.click(within(row).getByText('View on Instagram'));
    await user.click(within(within(row).getByRole('group', { name: 'Posted on' })).getByRole('button', { name: 'View on Instagram' }));
    expect(instagram.openInstagramPost).toHaveBeenCalledTimes(2);
    expect(instagram.openInstagramPost).toHaveBeenCalledWith('https://www.instagram.com/reel/abc/');
  });

  it('does nothing when the confirmation is cancelled', async () => {
    connected();
    const { onSave, user } = setup(workspace);
    await user.click(await screen.findByRole('button', { name: /Approve and post/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(instagram.publishInstagramReelFile).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the Instagram error and keeps the video unposted', async () => {
    connected();
    vi.mocked(instagram.publishInstagramReelFile).mockRejectedValue('Instagram refused the video upload (HTTP 400).');
    const { onSave, user } = setup(workspace);
    await user.click(await screen.findByRole('button', { name: /Approve and post/ }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Post to Instagram' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 400');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('asks to connect Instagram instead of opening the site when the profile is not connected', async () => {
    vi.mocked(instagram.claimInstagramConnection).mockResolvedValue(null);
    const { onConnectInstagram, onOpen, user } = setup(workspace);
    await user.click(await screen.findByRole('button', { name: /Connect Instagram to post/ }));
    expect(onConnectInstagram).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Approve and post/ })).not.toBeInTheDocument();
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
    await user.click(await within(row).findByRole('button', { name: /Approve and post/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Crunchy #bunny #snow');
    await user.click(within(dialog).getByRole('button', { name: 'Post to Instagram' }));
    expect(instagram.publishInstagramReelFile).toHaveBeenCalledWith(fresh.mediaSource, 'Crunchy\n\n#bunny #snow', '1', { coverMs: 2500, shareToFeed: false });
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
    const { user } = setup({ ...base, accounts: [profile('1', 'instagram')], videos: [bunny, review] });
    await user.click(screen.getByRole('button', { name: 'To approve 1' }));
    expect(screen.getByRole('listitem', { name: 'Hop review' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Bunny hop' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Posted 1' }));
    expect(screen.getByRole('listitem', { name: 'Bunny hop' })).toBeInTheDocument();
  });
});
