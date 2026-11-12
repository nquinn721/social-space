import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfileImageStudio from './ProfileImageStudio';
import * as ai from './imageAiService';

vi.mock('./imageAiService', async (original) => ({ ...(await original<typeof import('./imageAiService')>()), generateProfileImage: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  let count = 0;
  vi.mocked(ai.generateProfileImage).mockImplementation(async () => { count += 1; return { path: `C:\\pics\\profile-${count}.jpg`, preview: `data:image/jpeg;base64,${count}` }; });
});
afterEach(cleanup);

describe('profile image studio', () => {
  it('generates, refines from the current picture, regenerates and uses the chosen one', async () => {
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(<ProfileImageStudio onUse={onUse} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Describe the picture'), 'man in his 40s, beard');
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    expect(await screen.findByAltText('Generated profile picture')).toHaveAttribute('src', 'data:image/jpeg;base64,1');
    const first = vi.mocked(ai.generateProfileImage).mock.calls[0][0];
    expect(first.prompt).toContain('fictional person, man in his 40s, beard');
    expect(first.sourcePath).toBeUndefined();

    await user.type(screen.getByLabelText('Refine this picture'), 'add glasses');
    await user.click(screen.getByRole('button', { name: /Refine$/ }));
    expect(await screen.findByAltText('Generated profile picture')).toHaveAttribute('src', 'data:image/jpeg;base64,2');
    const refined = vi.mocked(ai.generateProfileImage).mock.calls[1][0];
    expect(refined.sourcePath).toBe('C:\\pics\\profile-1.jpg');
    expect(refined.prompt).toMatch(/^Keep this photo portrait the same, but add glasses\./);

    await user.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(await screen.findByAltText('Generated profile picture')).toHaveAttribute('src', 'data:image/jpeg;base64,3');
    expect(vi.mocked(ai.generateProfileImage).mock.calls[2][0].sourcePath).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Picture 1' }));
    await user.click(screen.getByRole('button', { name: /Use this picture/ }));
    expect(onUse).toHaveBeenCalledWith('C:\\pics\\profile-1.jpg');
  });

  it('shows why a picture could not be made', async () => {
    vi.mocked(ai.generateProfileImage).mockRejectedValueOnce('Add your xAI key under Settings > Video sources (Grok Imagine).');
    const user = userEvent.setup();
    render(<ProfileImageStudio suggestion="amber candle" onUse={vi.fn()} onClose={vi.fn()}/>);
    await user.click(screen.getByRole('button', { name: /^Generate$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add your xAI key');
  });

  it('keeps portraits fictional in the prompt', () => {
    expect(ai.buildPrompt('red hair', 'photo')).toMatch(/^photorealistic headshot portrait of a fictional person, red hair, /);
    // Product pictures must not sneak a person in next to the product.
    const product = ai.buildPrompt('amber candle', 'product');
    expect(product).not.toMatch(/person|portrait/);
    expect(product).toMatch(/no people/);
    expect(ai.buildPrompt('fox', 'logo', ['', 'orange'])).toBe('minimal modern logo mark, fox, orange, flat vector style, bold simple shapes, centered on a plain background, high contrast, app icon, no tiny details, no watermark');
  });
});
