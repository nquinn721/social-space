import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoLibrary, { categoryProgress } from './VideoLibrary';
import { titleFromPrompt } from './useVideoGenerations';
import type { Account, Video, Workspace } from './model';
import * as sources from './videoSourcesService';

vi.mock('./queueService', () => ({ chooseVideoFile: vi.fn() }));
vi.mock('./videoFileService', () => ({
  isLocalVideo: (path: string) => /^[a-z]:/i.test(path),
  videoPreviewUrl: vi.fn(async () => 'http://asset.localhost/bunny.mp4'),
  openVideoFile: vi.fn(async () => {}),
  showVideoInFolder: vi.fn(async () => {}),
}));
import * as files from './videoFileService';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('./videoSourcesService', () => ({
  DESKTOP_ONLY: 'desktop only',
  listVideoSources: vi.fn(),
  generateVideo: vi.fn(),
  getVideo: vi.fn(),
  saveGeneratedVideo: vi.fn(),
}));
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
  const view = render(<VideoLibrary workspace={workspace} loaded busy={false} onSave={onSave} onOpen={onOpen} onManageSources={onManageSources}/>);
  return { onSave, onOpen, onManageSources, view, user: userEvent.setup() };
}

describe('video library', () => {
  it('counts videos per category and how many are on every social', () => {
    expect(categoryProgress(base.videos!, ['instagram'])).toEqual({ total: 1, everywhere: 1 });
    expect(categoryProgress(base.videos!, ['instagram', 'tiktok'])).toEqual({ total: 1, everywhere: 0 });
    setup();
    expect(screen.getByRole('button', { name: 'Rabbit 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 video · 0 on every social')).toBeInTheDocument();
  });

  it("shows a video's status on each of the brand's socials and marks one posted", async () => {
    const { onSave, onOpen, user } = setup();
    const video = screen.getByRole('listitem', { name: 'Bunny hop' });
    expect(within(video).getByText('bunny.mp4 · 1 of 3 socials')).toBeInTheDocument();
    expect(within(video).getByRole('button', { name: 'Instagram' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(video).getByRole('button', { name: 'Upload to TikTok' }));
    expect(onOpen).toHaveBeenCalledWith('tiktok', 'post');
    await user.click(within(video).getByRole('button', { name: 'TikTok' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: ['instagram', 'tiktok'] })] }), 'Marked "Bunny hop" as posted on TikTok.');
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
    expect(screen.queryByLabelText('Caption')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Rabbit nap');
    await user.click(screen.getByRole('button', { name: /Add a caption/ }));
    await user.type(screen.getByLabelText('Caption'), 'So sleepy');
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
