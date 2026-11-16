import { useEffect, useState } from 'react';
import { Image } from 'lucide-react';
import { listVideoSources } from './videoSourcesService';

/** Pictures need nothing of their own: Grok Imagine makes them with the Grok video source's xAI key. */
export default function PictureSettings() {
  const [grok, setGrok] = useState<boolean | null>(null);
  useEffect(() => { void listVideoSources().then((state) => setGrok(state.sources.some((source) => source.provider === 'grok'))).catch(() => setGrok(false)); }, []);
  return <section className="settings-card" id="pictures">
    <h2><Image size={17}/> Pictures</h2>
    <p>Brand and profile pictures and YouTube banners are made with Grok Imagine from xAI. They use the same xAI key as your Grok video source, so there is nothing else to set up.</p>
    <div className={`status-line ${grok ? '' : 'off'}`}><span className="dot"/><span>{grok === null ? 'Checking…' : grok ? 'Your Grok video source\'s key is used for pictures.' : 'Add a Grok video source above with your xAI key to make pictures.'}</span></div>
  </section>;
}
