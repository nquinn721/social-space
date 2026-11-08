import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Bot, Check, Send, Settings2, Trash2, X as Close } from 'lucide-react';
import { chat, DEFAULT_SETTINGS, listModels, loadSettings, saveSettings, toolArguments, type AssistantSettings, type ChatMessage } from './ollamaClient';
import { errorText, runTool, SYSTEM_PROMPT, TOOL_SPECS, type ConfirmRequest, type ToolContext } from './tools';
import './assistant.css';

const MAX_TOOL_ROUNDS = 8;
const SUGGESTIONS = ['Find the newest verification code in my email', 'Suggest a bio for my Instagram under 150 characters', 'Which of my accounts are still planned?'];
const TOOL_LABELS: Record<string, string> = {
  get_workspace: 'Checked your workspace', save_account_profile: 'Saved a profile draft', choose_account_image: 'Asked for an image',
  open_platform_page: 'Opened a platform page', fill_platform_form: 'Filled a form', list_emails: 'Checked your inbox', read_email: 'Read an email',
  list_video_queue: 'Checked the video queue', post_to_x: 'Posting to X', generate_video: 'AI video', go_to_page: 'Changed page',
};
type Pending = ConfirmRequest & { resolve: (approved: boolean) => void };

export default function AssistantPanel({ context, onClose }: { context: Omit<ToolContext, 'confirm'>; onClose: () => void }) {
  const [settings, setSettings] = useState<AssistantSettings>(loadSettings);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [history, pending, busy]);
  useEffect(() => { if (showSettings) listModels(settings).then(setModels).catch(() => setModels([])); }, [showSettings, settings.baseUrl]);

  const confirm = (request: ConfirmRequest) => new Promise<boolean>((resolve) => setPending({ ...request, resolve }));
  function answer(approved: boolean) { pending?.resolve(approved); setPending(null); }
  function updateSettings(next: AssistantSettings) { setSettings(next); saveSettings(next); }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput(''); setError(''); setBusy(true);
    let conversation: ChatMessage[] = [...history, { role: 'user', content: text }];
    setHistory(conversation);
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const reply = await chat(settings, [{ role: 'system', content: SYSTEM_PROMPT }, ...conversation], TOOL_SPECS);
        const message: ChatMessage = { role: 'assistant', content: reply.content ?? '', ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}) };
        conversation = [...conversation, message];
        setHistory(conversation);
        if (!message.tool_calls?.length) return;
        for (const call of message.tool_calls) {
          let result: unknown;
          try { result = await runTool(call.function.name, toolArguments(call), { ...context, confirm }); }
          catch (reason) { result = { error: errorText(reason) }; }
          conversation = [...conversation, { role: 'tool', tool_name: call.function.name, content: JSON.stringify(result) }];
          setHistory(conversation);
        }
      }
      setError('The assistant stopped after several steps. Send another message to continue.');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return <aside className="assistant-panel" aria-label="Assistant">
    <header className="assistant-head">
      <div><span className="assistant-avatar"><Bot size={17}/></span><div><strong>Assistant</strong><small><span className="dot"/>{settings.model} · runs on this PC</small></div></div>
      <button className="icon-button" aria-label="Assistant settings" onClick={() => setShowSettings((value) => !value)}><Settings2 size={17}/></button>
      <button className="icon-button" aria-label="Clear conversation" disabled={busy} onClick={() => { setHistory([]); setError(''); }}><Trash2 size={17}/></button>
      <button className="icon-button" aria-label="Close assistant" onClick={onClose}><Close size={18}/></button>
    </header>
    {showSettings && <div className="assistant-settings">
      <label htmlFor="assistant-model">Ollama model</label>
      <input id="assistant-model" list="assistant-models" value={settings.model} onChange={(event) => updateSettings({ ...settings, model: event.target.value })}/>
      <datalist id="assistant-models">{models.map((model) => <option key={model} value={model}/>)}</datalist>
      <label htmlFor="assistant-url">Ollama address</label>
      <input id="assistant-url" value={settings.baseUrl} onChange={(event) => updateSettings({ ...settings, baseUrl: event.target.value })}/>
      <label className="assistant-check"><input type="checkbox" checked={settings.think} onChange={(event) => updateSettings({ ...settings, think: event.target.checked })}/> Let the model think first (slower, sometimes smarter)</label>
      <p>{models.length ? `${models.length} models installed.` : 'Ollama not found or no models installed.'} Default is {DEFAULT_SETTINGS.model}; install it with <code>ollama pull {DEFAULT_SETTINGS.model}</code>.</p>
    </div>}
    <div className="assistant-log" role="log">
      {!history.length && <div className="assistant-empty"><span className="assistant-avatar"><Bot size={22}/></span><strong>How can I help?</strong><p>I can draft profiles, fill sign-up forms for you to submit, find verification codes in your email, or post to X after you approve.</p>
        <div className="assistant-suggestions">{SUGGESTIONS.map((text) => <button key={text} type="button" onClick={() => setInput(text)}>{text}</button>)}</div></div>}
      {history.map((message, index) => {
        if (message.role === 'user') return <div key={index} className="bubble user">{message.content}</div>;
        if (message.role === 'tool') {
          const failed = message.content.startsWith('{"error"');
          return <div key={index} className={`tool-chip ${failed ? 'failed' : ''}`}>{failed ? '⚠ ' : '✓ '}{TOOL_LABELS[message.tool_name ?? ''] ?? message.tool_name}{failed && `: ${(JSON.parse(message.content) as { error: string }).error}`}</div>;
        }
        return message.content.trim() ? <div key={index} className="bubble bot">{message.content.trim()}</div> : null;
      })}
      {pending && <div className="assistant-confirm" role="alertdialog" aria-label={pending.title}>
        <strong>{pending.title}</strong><p>{pending.detail}</p>
        <div><button className="outline-button" onClick={() => answer(false)}>Cancel</button><button className="primary-button" onClick={() => answer(true)}><Check size={15}/> Approve</button></div>
      </div>}
      {busy && !pending && <div className="assistant-typing" role="status" aria-label="Thinking"><span/><span/><span/></div>}
      {error && <div className="error-message" role="alert">{error}</div>}
      <div ref={end}/>
    </div>
    <form className="assistant-input" onSubmit={send}>
      <textarea aria-label="Message the assistant" rows={1} value={input} placeholder="Ask anything…" onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>
      <button className="primary-button" aria-label="Send" disabled={busy || !input.trim()}><Send size={16}/></button>
    </form>
    <p className="assistant-hint">Enter to send, Shift+Enter for a new line. Nothing is posted without your approval.</p>
  </aside>;
}
