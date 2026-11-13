import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, Image, Trash2 } from 'lucide-react';
import { GEMINI_KEY_URL, geminiKeyStatus, removeGeminiKey, saveGeminiKey } from './brandImageService';
import { errorText } from './ui';

/** The Gemini API key for brand and profile pictures. Kept in Windows Credential Manager and shared with the partner's app. */
export default function GeminiKeySettings() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { void geminiKeyStatus().then(setSaved).catch(() => setSaved(false)); }, []);
  async function run(action: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  const save = (event: FormEvent) => { event.preventDefault(); void run(async () => { await saveGeminiKey(key); setKey(''); setSaved(true); setNote('Gemini key checked and saved. It syncs to your partner\'s app.'); }); };
  const remove = () => run(async () => { await removeGeminiKey(); setSaved(false); setNote('Gemini key removed from this PC.'); });
  return <section className="settings-card" id="pictures">
    <h2><Image size={17}/> Pictures</h2>
    <p>Brand and profile pictures (and YouTube banners) are made with Gemini from Google. Get an API key at <a href={GEMINI_KEY_URL} target="_blank" rel="noreferrer">aistudio.google.com <ExternalLink size={12}/></a> (Get API key, then Create API key) and paste it here. Image generation can need billing turned on for the key's Google Cloud project; each picture costs a few cents. The key is checked with Google, kept in Windows Credential Manager, and shared, encrypted, with your partner's app.</p>
    <div className={`status-line ${saved ? '' : 'off'}`}><span className="dot"/><span>{saved === null ? 'Checking…' : saved ? 'A Gemini key is saved. Pictures are made with Gemini.' : 'No Gemini key yet. The picture maker uses Grok until you add one.'}</span>{saved && <button type="button" className="ghost-button small-button" disabled={working} onClick={() => void remove()}><Trash2 size={14}/> Remove</button>}</div>
    <form onSubmit={save}>
      <label htmlFor="gemini-key">{saved ? 'Replace the Gemini API key' : 'Gemini API key'}</label>
      <div className="idea-row"><input id="gemini-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder="Paste the key from AI Studio"/>
        <button className="primary-button" disabled={working || !key.trim()}>{working ? 'Checking…' : 'Save key'}</button></div>
    </form>
    {note && <p className="success-message" role="status">{note}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
