import { describe, expect, it, vi } from 'vitest';

vi.mock('./assistant/grokClient', () => ({ chat: vi.fn(), loadSettings: () => ({ model: 'grok-4.3' }) }));
import * as grok from './assistant/grokClient';
import { ask, RATE_LIMIT_RETRY_MS } from './seriesWriter';

describe('asking Grok', () => {
  it('tries once more after a pause when xAI rate limits', async () => {
    const wait = vi.fn(async () => {});
    vi.mocked(grok.chat).mockRejectedValueOnce(new Error('xAI is rate limiting this key or the team is out of credits.')).mockResolvedValueOnce({ role: 'assistant', content: '{}' });
    expect(await ask([{ role: 'user', content: 'hi' }], wait)).toEqual({ role: 'assistant', content: '{}' });
    expect(wait).toHaveBeenCalledWith(RATE_LIMIT_RETRY_MS);
  });

  it('does not retry other errors', async () => {
    const wait = vi.fn(async () => {});
    vi.mocked(grok.chat).mockRejectedValueOnce(new Error('xAI rejected the key.'));
    await expect(ask([{ role: 'user', content: 'hi' }], wait)).rejects.toThrow('rejected');
    expect(wait).not.toHaveBeenCalled();
  });
});
