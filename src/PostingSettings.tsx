import { Send } from 'lucide-react';
import { stateLabel } from './appReviews';
import { PLATFORMS } from './model';
import { apiReview, postMode, postModeNote } from './postingMode';
import { BrandMark } from './ui';
import './setup.css';

/** How each social posts: by itself through its API, or through its own upload page in an app window. */
export default function PostingSettings({ marks }: { marks?: Record<string, number> }) {
  return <section className="settings-card" id="posting">
    <h2><Send size={17}/> Posting</h2>
    <p>Socials whose API isn't approved yet post through their own upload page in a Social Space window, signed in as the brand. The video, caption, hashtags, title, cover and settings are filled in; you press Post (YouTube: Publish). Each brand has its own sign-in for these windows.</p>
    <ul className="posting-modes">{PLATFORMS.map((platform) => {
      const review = apiReview(marks, platform.id);
      return <li key={platform.id}>
        <BrandMark platform={platform.id} small/>
        <div><strong>{platform.name}</strong> <span className={`review-pill ${postMode(platform.id) === 'api' ? 'approved' : ''}`}>{postMode(platform.id) === 'api' ? 'API' : 'Browser'}</span>
          {review && <small> · App review: {stateLabel(review.state)}</small>}
          <p className="footnote">{postModeNote(marks, platform.id)}</p></div>
      </li>;
    })}</ul>
  </section>;
}
