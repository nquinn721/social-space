import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssistantPanel from './AssistantPanel';
import * as client from './grokClient';
import type { Workspace } from '../model';

vi.mock('./grokClient', async (original) => ({ ...(await original<typeof import('./grokClient')>()), chat: vi.fn(), listModels: vi.fn() }));

const workspace: Workspace = { businessName: 'Example LLC', brands: [], accounts: [], channels: [] };
const context = { getWorkspace: () => workspace, saveWorkspace: vi.fn(async (next: Workspace) => next), navigate: vi.fn() };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(client.listModels).mockResolvedValue([]); });
afterEach(cleanup);

describe('assistant panel', () => {
  it('runs tool calls, feeds results back, and shows the reply', async () => {
    vi.mocked(client.chat)
      .mockResolvedValueOnce({ role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'go_to_page', arguments: { page: 'brands' } } }] })
      .mockResolvedValueOnce({ role: 'assistant', content: 'Here are your accounts.' });
    const user = userEvent.setup();
    render(<AssistantPanel context={context} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Message the assistant'), 'show accounts{Enter}');
    expect(await screen.findByText('Here are your accounts.')).toBeInTheDocument();
    expect(context.navigate).toHaveBeenCalledWith('brands');
    expect(screen.getByText(/Changed page/)).toBeInTheDocument();
    const second = vi.mocked(client.chat).mock.calls[1][1];
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', tool_name: 'go_to_page' });
    expect(second[0].role).toBe('system');
  });

  it('shows a clear error when Grok cannot be used', async () => {
    vi.mocked(client.chat).mockRejectedValue('Add your xAI key under Settings > Video sources (Grok Imagine).');
    const user = userEvent.setup();
    render(<AssistantPanel context={context} onClose={vi.fn()}/>);
    await user.type(screen.getByLabelText('Message the assistant'), 'hi{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Add your xAI key');
  });
});
