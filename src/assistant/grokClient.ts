import { invoke, isTauri } from '@tauri-apps/api/core';

export type ToolCall = { id?: string; type?: 'function'; function: { name: string; arguments: Record<string, unknown> | string } };
/** A chat turn as the app keeps it. `tool_name` is only for showing tool results; Grok matches them by `tool_call_id`. */
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string; tool_name?: string };
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } } };
export type AssistantSettings = { model: string };

/** grok-4.3: quick replies and dependable tool calling at a lower price than the flagship. */
export const DEFAULT_MODEL = 'grok-4.3';
export const DEFAULT_SETTINGS: AssistantSettings = { model: DEFAULT_MODEL };
const SETTINGS_KEY = 'socialspace-assistant-settings';

export function loadSettings(): AssistantSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<AssistantSettings> | null;
    // Settings saved before the switch to Grok name a local Ollama model.
    const model = typeof saved?.model === 'string' && saved.model.startsWith('grok') ? saved.model : DEFAULT_MODEL;
    return { model };
  } catch { return DEFAULT_SETTINGS; }
}
export function saveSettings(settings: AssistantSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* settings stay for this session */ }
}

function desktopOnly() { if (!isTauri()) throw new Error('Open the desktop app to use the assistant.'); }

/** Grok chat models this xAI key can use. */
export async function listModels(): Promise<string[]> {
  desktopOnly();
  return invoke('grok_models');
}

/** The OpenAI-style messages xAI expects: tool call ids, string arguments, no app-only fields. */
export function toApiMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id ?? '' };
    if (message.role === 'assistant' && message.tool_calls?.length) {
      return { role: 'assistant', content: message.content, tool_calls: message.tool_calls.map((call, index) => ({
        id: call.id ?? `call_${index}`, type: 'function', function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) },
      })) };
    }
    return { role: message.role, content: message.content };
  });
}

export async function chat(settings: AssistantSettings, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
  desktopOnly();
  const reply = await invoke<{ content?: string | null; tool_calls?: ToolCall[] }>('grok_chat', { model: settings.model, messages: toApiMessages(messages), tools });
  return { role: 'assistant', content: reply.content ?? '', ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) };
}

export function toolArguments(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments;
  if (typeof raw !== 'string') return raw ?? {};
  try { const parsed = JSON.parse(raw) as unknown; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
