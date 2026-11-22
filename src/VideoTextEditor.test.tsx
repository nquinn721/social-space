import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VideoTextEditor from './VideoTextEditor';
import type { Video } from './model';

vi.mock('./videoFileService', () => ({
  videoPreviewUrl: vi.fn(async () => 'http://asset.localhost/bunny.mp4'),
  saveEditedVideo: vi.fn(async () => 'C:\\Videos\\SocialSpace\\softwings25\\InspirationalBunny\\Sunrise with text.mp4'),
}));
vi.mock('./assistant/overlayWriter', () => ({ writeOverlays: vi.fn() }));
vi.mock('./textOverlays', async (original) => ({ ...(await original<typeof import('./textOverlays')>()), detectScenes: vi.fn(async () => [[0, 3], [3, 8]]), renderVideo: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), ext: 'mp4' })) }));
import * as files from './videoFileService';
import * as writer from './assistant/overlayWriter';
import * as overlays from './textOverlays';

const video: Video = { id: 'v1', brandId: 'b', categoryId: 'c', title: 'Sunrise', mediaSource: 'C:\\Videos\\sunrise.mp4', caption: '', posted: [], createdAt: 1, prompt: 'a bunny at sunrise' };

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});
afterEach(cleanup);

async function open(onSaved = vi.fn(async () => true), onClose = vi.fn()) {
  render(<VideoTextEditor video={video} brandName="softwings25" brandNotes="" categoryName="InspirationalBunny" onSaved={onSaved} onClose={onClose}/>);
  const player = await screen.findByLabelText('Preview of Sunrise') as HTMLVideoElement;
  Object.defineProperty(player, 'duration', { value: 8, configurable: true });
  fireEvent.loadedMetadata(player);
  await screen.findByText('2 scenes');
  return { onSaved, onClose };
}

it('writes a line per scene with Grok, lets Nate edit it, and saves the video into the category', async () => {
  vi.mocked(writer.writeOverlays).mockResolvedValue([{ text: 'Every hop counts', animation: 'pop' }, { text: 'Keep going', animation: 'typewriter' }, { text: 'You got this', animation: 'fade' }]);
  const { onSaved, onClose } = await open();
  await userEvent.type(screen.getByLabelText('What should the text say?'), 'inspirational quotes');
  await userEvent.click(screen.getByRole('button', { name: /Write with AI/ }));
  expect(await screen.findByDisplayValue('Every hop counts')).toBeInTheDocument();
  const request = vi.mocked(writer.writeOverlays).mock.calls[0][0];
  expect(request).toMatchObject({ brand: 'softwings25', category: 'InspirationalBunny', direction: 'inspirational quotes', prompt: 'a bunny at sunrise' });
  expect(request.beats).toEqual([[0, 3], [3, 5.5], [5.5, 8]]);

  const first = screen.getByDisplayValue('Every hop counts');
  await userEvent.clear(first);
  await userEvent.type(first, 'Small hops, big dreams');
  await userEvent.click(screen.getByRole('button', { name: 'Save video' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(vi.mocked(files.saveEditedVideo)).toHaveBeenCalledWith(expect.any(Uint8Array), { brand: 'softwings25', category: 'InspirationalBunny', title: 'Sunrise with text', ext: 'mp4' });
  const [, edit] = onSaved.mock.calls[0] as unknown as [string, { sourcePath: string; sourceVideoId: string; overlays: { text: string; animation: string }[]; direction: string }];
  expect(edit.sourcePath).toBe(video.mediaSource);
  expect(edit.sourceVideoId).toBe('v1');
  expect(edit.direction).toBe('inspirational quotes');
  expect(edit.overlays.map((item) => item.text)).toEqual(['Small hops, big dreams', 'Keep going', 'You got this']);
  expect(edit.overlays[0].animation).toBe('pop');
  expect(vi.mocked(overlays.renderVideo).mock.calls[0][1].overlays).toHaveLength(3);
  expect(onClose).toHaveBeenCalled();
});

it('adds text by hand for a scene and needs some text before saving', async () => {
  await open();
  expect(screen.getByRole('button', { name: 'Save video' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: /Text for scene 2/ }));
  const box = screen.getByPlaceholderText('Type the text');
  expect(screen.getByText(/1 · 0:03\.0–0:08\.0/)).toBeInTheDocument();
  await userEvent.type(box, 'Hello');
  await userEvent.selectOptions(screen.getByDisplayValue('Fade'), 'typewriter');
  expect(screen.getByRole('button', { name: 'Save video' })).toBeEnabled();
});

it('asks before closing with unsaved text', async () => {
  const { onClose } = await open();
  await userEvent.click(screen.getByRole('button', { name: /Add text at/ }));
  await userEvent.type(screen.getByPlaceholderText('Type the text'), 'Hi');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Close' })); });
  expect(onClose).toHaveBeenCalled();
});
