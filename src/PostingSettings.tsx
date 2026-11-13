import { Send } from 'lucide-react';
import { PLATFORMS } from './model';
import { postMode, postModeNote } from './postingMode';
import { BrandMark } from './ui';
import './setup.css';

/** How each social posts: by itself through its API, or through its own upload page in an app window. */
export default function PostingSettings({ marks }: { marks?: Record<string, number> }) {
  return <section className="settings-card" id="posting">
    <h2><Send size={17}/> Posting</h2>
    <p>Instagram posts by itself through Meta's API. TikTok, YouTube and X open their own upload page in the brand's window with the video, caption, hashtags, title and cover filled in, and you press Post.</p>
    <ul className="posting-modes">{PLATFORMS.map((platform) => {
      return <li key={platform.id}>
        <BrandMark platform={platform.id} small/>
        <div><strong>{platform.name}</strong> <span className={`status-chip ${postMode(platform.id) === 'api' ? 'tone-ok' : 'tone-ready'}`}>{postMode(platform.id) === 'api' ? 'Posts by itself' : 'You press Post'}</span>
          <p className="footnote">{postModeNote(marks, platform.id)}</p></div>
      </li>;
    })}</ul>
  </section>;
}
