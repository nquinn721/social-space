import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SeriesPanel, { defaultSource, seriesDurations } from './SeriesPanel';
import type { Series, Workspace } from './model';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('./videoSourcesService', () => ({ DESKTOP_ONLY: 'desktop only', listVideoSources: vi.fn(), generateVideo: vi.fn(), getVideo: vi.fn(), saveGeneratedVideo: vi.fn() }));
vi.mock('./assistant/grokClient', () => ({ chat: vi.fn(), loadSettings: () => ({ model: 'grok-4.3' }) }));
vi.mock('./imageAiService', () => ({ generateProfileImage: vi.fn() }));
vi.mock('./brandImageService', () => ({ keepSquare: vi.fn(), brandImagePreview: vi.fn(async () => '') }));
import * as sources from './videoSourcesService';
import * as grok from './assistant/grokClient';
import * as images from './imageAiService';
import * as brandImages from './brandImageService';

const grokSource = { id: 'g1', name: 'Main Grok', provider: 'grok' as const, status: 'verified' as const, checkedAt: 1, creditsRemaining: null, detail: null };
const klingSource = { id: 'k1', name: 'Kling', provider: 'kling' as const, status: 'verified' as const, checkedAt: 1, creditsRemaining: null, detail: null };
const base: Workspace = { businessName: '', channels: [], brands: [{ id: 'mia', name: 'Massage With Mia', notes: 'Relaxing massage tips' }], accounts: [{ id: 'a', platform: 'tiktok', label: 'Mia', handle: 'mia', status: 'active', notes: '', brandId: 'mia' }], categories: [], videos: [] };
const story: Series = {
  id: 's', brandId: 'mia', categoryId: 'c', title: 'Knots', premise: 'p', bible: 'A tense office worker learns to relax.', style: 'warm film look',
  characters: [{ id: 'k', name: 'Sam', description: 'office worker, blue shirt' }],
  episodes: [{ id: 'e1', number: 1, title: 'Stiff', summary: 'Sam is stiff.' }, { id: 'e2', number: 2, title: 'Loose', summary: 'Sam relaxes.' }],
  aspectRatio: '9:16', duration: 10, createdAt: 1,
};
const withStory: Workspace = { ...base, categories: [{ id: 'c', brandId: 'mia', name: 'Knots' }], series: [story] };

function setup(workspace = base) {
  const saved: Workspace[] = [];
  const onSave = vi.fn(async (next: Workspace) => { saved.push(next); view.rerender(<SeriesPanel workspace={next} brand={next.brands[0]} loaded busy={false} onSave={onSave}/>); return true as boolean | undefined; });
  const view = render(<SeriesPanel workspace={workspace} brand={workspace.brands[0]} loaded busy={false} onSave={onSave}/>);
  return { onSave, saved, user: userEvent.setup() };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sources.listVideoSources).mockResolvedValue({ active: 'k1', sources: [klingSource, grokSource] });
});

describe('series panel', () => {
  it('prefers Grok for clips even when another source is active', () => {
    expect(defaultSource({ active: 'k1', sources: [klingSource, grokSource] })?.id).toBe('g1');
    expect(defaultSource({ active: 'k1', sources: [klingSource] })?.id).toBe('k1');
    expect(seriesDurations(grokSource)).toEqual([5, 8, 10]);
    expect(seriesDurations(klingSource)).toEqual([5, 10]);
  });

  it('has Grok plan a series into a new category', async () => {
    vi.mocked(grok.chat).mockResolvedValue({ role: 'assistant', content: JSON.stringify({ title: 'Knots', bible: 'B', style: 'S', characters: [{ name: 'Sam', description: 'office worker' }], episodes: [{ title: 'One', summary: 'a' }, { title: 'Two', summary: 'b' }, { title: 'Three', summary: 'c' }, { title: 'Four', summary: 'd' }] }) });
    const { saved, user } = setup();
    await user.click(screen.getAllByRole('button', { name: /New series/ })[0]);
    await user.type(screen.getByLabelText('What is the story about?'), 'A stiff office worker learns to relax');
    expect(await screen.findByRole('option', { name: 'Main Grok · Grok Imagine' })).toBeInTheDocument();
    expect(screen.getByLabelText('Clips made with')).toHaveValue('g1');
    await user.click(screen.getByRole('button', { name: /Plan the series/ }));
    const next = saved.at(-1)!;
    expect(next.categories).toEqual([expect.objectContaining({ brandId: 'mia', name: 'Knots' })]);
    expect(next.series?.[0]).toMatchObject({ title: 'Knots', sourceId: 'g1', duration: 10, aspectRatio: '9:16', categoryId: next.categories![0].id });
    expect(next.series?.[0].episodes.map((item) => item.number)).toEqual([1, 2, 3, 4]);
    expect(await screen.findByRole('heading', { name: 'Knots' })).toBeInTheDocument();
  });

  it('writes a script, draws a character and makes the clip with the picture and a Part caption', async () => {
    vi.mocked(grok.chat).mockResolvedValue({ role: 'assistant', content: '{"script":"Sam rolls his shoulders.","videoPrompt":"Sam at his desk, rubbing his neck.","caption":"Desk neck?"}' });
    vi.mocked(images.generateProfileImage).mockResolvedValue({ path: 'p.png', preview: 'data:image/png;base64,AA' });
    vi.mocked(brandImages.keepSquare).mockResolvedValue('sam.jpg');
    vi.mocked(sources.generateVideo).mockResolvedValue({ id: 't1', status: 'pending', message: null, videoUrl: null, sourceId: 'g1', sourceName: 'Main Grok', provider: 'grok' });
    const { saved, user } = setup(withStory);
    await user.click(screen.getByRole('button', { name: /Knots/ }));
    await screen.findByText(/Clips are made with Main Grok/);
    await user.click(screen.getByRole('button', { name: /Make reference picture/ }));
    expect(images.generateProfileImage).toHaveBeenCalledWith({ prompt: expect.stringContaining('fictional character named Sam') });
    expect(saved.at(-1)?.series?.[0].characters[0].imageFile).toBe('sam.jpg');

    const first = screen.getAllByRole('listitem').find((item) => within(item).queryByText('Part 1 of 2'))!;
    expect(within(first).getByRole('button', { name: /Make clip/ })).toBeDisabled();
    await user.click(within(first).getByRole('button', { name: /Write script/ }));
    expect(saved.at(-1)?.series?.[0].episodes[0].script).toBe('Sam rolls his shoulders.');
    await user.click(within(first).getByRole('button', { name: /Make clip/ }));
    expect(sources.generateVideo).toHaveBeenCalledWith('g1', expect.stringContaining('Sam is the character from <IMAGE_0>'), '9:16', 10, ['sam.jpg']);
    const video = saved.at(-1)?.videos?.[0];
    expect(video).toMatchObject({ seriesId: 's', episode: 1, categoryId: 'c', title: 'Knots: Part 1 of 2', caption: 'Part 1 of 2 · Knots\n\nDesk neck?' });
  });

  it('describes characters in words when the series uses Kling', async () => {
    vi.mocked(sources.generateVideo).mockResolvedValue({ id: 't1', status: 'pending', message: null, videoUrl: null, sourceId: 'k1', sourceName: 'Kling', provider: 'kling' });
    const kling = { ...withStory, series: [{ ...story, sourceId: 'k1', characters: [{ ...story.characters[0], imageFile: 'sam.jpg' }], episodes: [{ ...story.episodes[0], script: 's', videoPrompt: 'Sam stretches.' }, story.episodes[1]] }] };
    const { user } = setup(kling);
    await user.click(screen.getByRole('button', { name: /Knots/ }));
    await screen.findByText(/can't take character pictures/);
    expect(screen.queryByRole('button', { name: /Make a new picture/ })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /Make clip/ })[0]);
    expect(sources.generateVideo).toHaveBeenCalledWith('k1', expect.stringContaining('Sam: office worker, blue shirt.'), '9:16', 10, []);
  });
});
