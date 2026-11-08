import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VideoLibrary, { categoryProgress } from './VideoLibrary';
import type { Account, Workspace } from './model';

vi.mock('./queueService', () => ({ chooseVideoFile: vi.fn() }));
afterEach(cleanup);
const profile = (id: string, platform: Account['platform'], status: Account['status'] = 'active'): Account => ({ id, platform, label: 'Mia', handle: 'mia', status, notes: '', brandId: 'mia' });
const base: Workspace = {
  businessName: '', channels: [],
  brands: [{ id: 'mia', name: 'Massage With Mia', notes: '' }],
  accounts: [profile('1', 'instagram'), profile('2', 'tiktok'), profile('3', 'x', 'planned')],
  categories: [{ id: 'rabbit', brandId: 'mia', name: 'Rabbit' }],
  videos: [{ id: 'v1', brandId: 'mia', categoryId: 'rabbit', title: 'Bunny hop', mediaSource: '', caption: '', posted: ['instagram'], createdAt: 1 }],
};
function setup(workspace = base) {
  const onSave = vi.fn(async () => true);
  const onOpen = vi.fn();
  render(<VideoLibrary workspace={workspace} loaded busy={false} onSave={onSave} onOpen={onOpen}/>);
  return { onSave, onOpen, user: userEvent.setup() };
}

describe('video library', () => {
  it('counts videos per category and how many are on every social', () => {
    expect(categoryProgress(base.videos!, ['instagram'])).toEqual({ total: 1, everywhere: 1 });
    expect(categoryProgress(base.videos!, ['instagram', 'tiktok'])).toEqual({ total: 1, everywhere: 0 });
    setup();
    expect(screen.getByRole('button', { name: /Rabbit 1 video · 0 on every social/ })).toBeInTheDocument();
  });

  it("shows a video's status on each of the brand's socials and marks one posted", async () => {
    const { onSave, onOpen, user } = setup();
    const video = screen.getByRole('article', { name: 'Bunny hop' });
    expect(within(video).getByText('1 of 3 socials')).toBeInTheDocument();
    expect(within(video).getByRole('button', { name: /Instagram/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(video).getByRole('button', { name: 'Upload to TikTok' }));
    expect(onOpen).toHaveBeenCalledWith('tiktok', 'post');
    await user.click(within(video).getByRole('button', { name: /^TikTok/ }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ videos: [expect.objectContaining({ posted: ['instagram', 'tiktok'] })] }), 'Marked "Bunny hop" as posted on TikTok.');
  });

  it('adds a category and a video to it', async () => {
    const { onSave, user } = setup();
    await user.type(screen.getByLabelText('New category'), 'Cats');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ categories: [base.categories![0], expect.objectContaining({ brandId: 'mia', name: 'Cats' })] }), 'Added the Cats category.');
    await user.type(screen.getByLabelText('Title'), 'Rabbit nap');
    await user.click(screen.getByRole('button', { name: 'Add video' }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ videos: [base.videos![0], expect.objectContaining({ title: 'Rabbit nap', posted: [] })] }), expect.any(String));
  });
});
