import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfileImageStudio from './ProfileImageStudio';
import * as ai from './imageAiService';

vi.mock('./imageAiService', async (original) => ({ ...(await original<typeof import('./imageAiService')>()), imageAiStatus: vi.fn(), startImageAi: vi.fn(), generateProfileImage: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ai.imageAiStatus).mockResolvedValue({ running: true, looks: ['fast', 'detailed'], canStart: true });
  let count = 0;
  vi.mocked(ai.generateProfileImage).mockImplementation(async () => { count += 1; return { path: `C:\\pics\\profile-${count}.png`, seed: count, preview: `data:image/png;base64,${count}` }; });
});
afterEach(cleanup);

describe('profile image studio', () => {
  it('generates, refines from the current picture, regenerates and uses the chosen one', async () => {
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(<ProfileImageStudio onUse={onUse} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Describe the picture'), 'man in his 40s, beard');
    await user.click(await screen.findByRole('button', { name: /^Generate$/ }));
    expect(await screen.findByAltText('Generated profile picture')).toHaveAttribute('src', 'data:image/png;base64,1');
    const first = vi.mocked(ai.generateProfileImage).mock.calls[0][0];
    expect(first.prompt).toContain('fictional person, man in his 40s, beard');
    expect(first.look).toBe('detailed');
    expect(first.sourcePath).toBeUndefined();

    await user.type(screen.getByLabelText('Refine this picture'), 'add glasses');
    await user.click(screen.getByRole('button', { name: 'Light change' }));
    await user.click(screen.getByRole('button', { name: /Refine$/ }));
    expect(await screen.findByAltText('Generated profile picture')).toHaveAttribute('src', 'data:image/png;base64,2');
    const refined = vi.mocked(ai.generateProfileImage).mock.calls[1][0];
    expect(refined).toMatchObject({ sourcePath: 'C:\\pics\\profile-1.png', strength: ai.REFINE_STRENGTH.light });
    expect(refined.prompt).toContain('beard, add glasses');

    await user.click(screen.getByRole('button', { name: 'Fast' }));
    await user.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(await screen.findByAltText('Generated profile picture')).toHaveAttribute('src', 'data:image/png;base64,3');
    const regenerated = vi.mocked(ai.generateProfileImage).mock.calls[2][0];
    expect(regenerated.look).toBe('fast');
    expect(regenerated.sourcePath).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Picture 1' }));
    await user.click(screen.getByRole('button', { name: /Use this picture/ }));
    expect(onUse).toHaveBeenCalledWith('C:\\pics\\profile-1.png');
  });

  it('offers to start ComfyUI when it is not running', async () => {
    vi.mocked(ai.imageAiStatus).mockResolvedValueOnce({ running: false, looks: [], canStart: true });
    const user = userEvent.setup();
    render(<ProfileImageStudio onUse={vi.fn()} onClose={vi.fn()}/>);
    expect(await screen.findByText('ComfyUI is not running.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Start ComfyUI/ }));
    expect(ai.startImageAi).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /^Generate$/ })).toBeDisabled();
  });

  it('keeps portraits fictional in the prompt', () => {
    expect(ai.buildPrompt('red hair', 'photo').prompt).toMatch(/^photorealistic headshot portrait of a fictional person, red hair, /);
    // Product pictures must not sneak a person in next to the product.
    const product = ai.buildPrompt('amber candle', 'product');
    expect(product.prompt).not.toMatch(/person|portrait/);
    expect(product.negative).toMatch(/^people, person, face/);
    expect(ai.buildPrompt('fox', 'logo', ['', 'orange']).prompt).toBe('minimal modern logo mark, fox, orange, flat vector style, bold simple shapes, centered on a plain background, high contrast, app icon');
  });
});
