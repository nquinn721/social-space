import { invoke, isTauri } from '@tauri-apps/api/core';

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> | string } };
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_name?: string; thinking?: string };
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } } };
export type AssistantSettings = { baseUrl: string; model: string; think: boolean };

/** qwen3:8b: fast on a consumer GPU (about 5 GB) with dependable tool calling. */
export const DEFAULT_MODEL = 'qwen3:8b';
export const DEFAULT_SETTINGS: AssistantSettings = { baseUrl: 'http://127.0.0.1:11434', model: DEFAULT_MODEL, think: false };
const SETTINGS_KEY = 'socialspace-assistant-settings';

export function loadSettings(): AssistantSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<AssistantSettings> | null;
    return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  } catch { return DEFAULT_SETTINGS; }
}
export function saveSettings(settings: AssistantSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* settings stay for this session */ }
}

function base(url: string) { return url.trim().replace(/\/+$/, ''); }

export async function listModels(settings: AssistantSettings): Promise<string[]> {
  if (isTauri()) return invoke('ollama_models', { baseUrl: settings.baseUrl });
  const response = await fetch(`${base(settings.baseUrl)}/api/tags`);
  if (!response.ok) throw new Error('Could not reach Ollama.');
  const body = await response.json() as { models?: { name: string }[] };
  return (body.models ?? []).map((model) => model.name);
}

export async function chat(settings: AssistantSettings, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
  if (isTauri()) return invoke('ollama_chat', { baseUrl: settings.baseUrl, model: settings.model, messages, tools, think: settings.think });
  const response = await fetch(`${base(settings.baseUrl)}/api/chat`, { method: 'POST', body: JSON.stringify({ model: settings.model, messages, tools, stream: false, think: settings.think }) });
  const body = await response.json() as { message?: ChatMessage; error?: string };
  if (!response.ok || !body.message) throw new Error(body.error ?? 'Ollama returned an error.');
  return body.message;
}

export function toolArguments(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments;
  if (typeof raw !== 'string') return raw ?? {};
  try { const parsed = JSON.parse(raw) as unknown; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
