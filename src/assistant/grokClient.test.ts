import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, loadSettings, saveSettings, toApiMessages } from './grokClient';

afterEach(() => localStorage.clear());

describe('grok client', () => {
  it('sends tool calls and results in the shape xAI expects', () => {
    expect(toApiMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', function: { name: 'go_to_page', arguments: { page: 'accounts' } } }, { function: { name: 'get_workspace', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_9', tool_name: 'go_to_page', content: '{"ok":true}' },
    ])).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_9', type: 'function', function: { name: 'go_to_page', arguments: '{"page":"accounts"}' } },
        { id: 'call_1', type: 'function', function: { name: 'get_workspace', arguments: '{}' } },
      ] },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_9' },
    ]);
  });

  it('moves settings saved for a local model over to Grok', () => {
    localStorage.setItem('socialspace-assistant-settings', JSON.stringify({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', think: true }));
    expect(loadSettings()).toEqual({ model: DEFAULT_MODEL });
    saveSettings({ model: 'grok-4.7' });
    expect(loadSettings()).toEqual({ model: 'grok-4.7' });
  });
});
