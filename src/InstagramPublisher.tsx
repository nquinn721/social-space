import { useEffect, useState, type FormEvent } from 'react';
import { chooseInstagramVideo, connectInstagram, disconnectInstagram, instagramConnection, publishInstagramPhoto, publishInstagramReel, publishInstagramReelFile, type InstagramIdentity } from './instagramService';
import { openPlatformAction } from './service';

type PostKind = 'photo' | 'reel-link' | 'reel-file';
const POST_KINDS: { id: PostKind; label: string }[] = [
  { id: 'photo', label: 'Photo from a link' },
  { id: 'reel-link', label: 'Reel from a link' },
  { id: 'reel-file', label: 'Reel from this PC' },
];
const PUBLISHED: Record<PostKind, string> = {
  photo: 'Your photo was published to Instagram.',
  'reel-link': 'Your Reel was published to Instagram.',
  'reel-file': 'Your Reel was uploaded and published to Instagram.',
};
const CAPTION_LIMIT = 2200;

function errorMessage(reason: unknown) { return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'The request failed.'; }

/** Setup steps for Meta's official API. Shown until an account is connected. */
function SetupGuide({ busy, onOpenDeveloper }: { busy: boolean; onOpenDeveloper: () => void }) {
  return <div className="instagram-setup">
    <p>Posting uses Meta's official Instagram API. It works only for professional (Business or Creator) accounts. One-time setup:</p>
    <ol>
      <li>In the Instagram app, open <strong>Settings → Account type and tools → Switch to professional account</strong> and pick Business or Creator.</li>
      <li>At Meta for Developers, create an app (use case: <strong>Manage messaging & content on Instagram</strong>) and open <strong>API setup with Instagram login</strong>.</li>
      <li>Under <strong>Generate access tokens</strong>, add your Instagram account and sign in. If Instagram shows a tester invite, accept it in <strong>Settings → Website permissions → Apps and websites</strong>.</li>
      <li>Copy the token (it starts with <code>IG</code>) and paste it below. The app keeps it fresh for you.</li>
    </ol>
    <button className="text-button setup-link" disabled={busy} onClick={onOpenDeveloper}>Open Meta for Developers</button>
    <p className="field-hint">Using a Facebook Page token instead? Enter the Instagram account ID too. Only a Page token can upload a video straight from this PC.</p>
  </div>;
}

export default function InstagramPublisher() {
  const [identity, setIdentity] = useState<InstagramIdentity | null>(null);
  const [available, setAvailable] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [token, setToken] = useState('');
  const [kind, setKind] = useState<PostKind>('photo');
  const [mediaUrl, setMediaUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { instagramConnection().then((value) => { setIdentity(value); setAvailable(true); }).catch(() => setAvailable(false)); }, []);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  function connect(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    void run(async () => { setIdentity(await connectInstagram(accountId.trim(), token.trim())); setToken(''); setAccountId(''); setMessage('Instagram account connected.'); });
  }
  const source = kind === 'reel-file' ? filePath : mediaUrl.trim();
  function publish(event: FormEvent) {
    event.preventDefault();
    if (!source) return;
    void run(async () => {
      if (kind === 'photo') await publishInstagramPhoto(source, caption.trim());
      else if (kind === 'reel-link') await publishInstagramReel(source, caption.trim());
      else await publishInstagramReelFile(source, caption.trim());
      setMediaUrl(''); setFilePath(''); setCaption('');
      setMessage(PUBLISHED[kind]);
    });
  }
  const pickFile = () => run(async () => { const path = await chooseInstagramVideo(); if (path) setFilePath(path); });
  const fileNeedsPageToken = kind === 'reel-file' && identity?.login === 'instagram';

  return <section className="settings-card instagram-publisher">
    <h2>Post to Instagram</h2>
    {!available ? <p>Open the desktop app to connect an Instagram account.</p> : identity ? <>
      <p>Connected as @{identity.username}{identity.login === 'instagram' ? ' with an Instagram token' : ' with a Facebook Page token'}. Posts go live right away.</p>
      <div className="segmented instagram-kinds" role="group" aria-label="What to post">
        {POST_KINDS.map((option) => <button key={option.id} type="button" aria-pressed={kind === option.id} disabled={busy} onClick={() => { setKind(option.id); setError(''); }}>{option.label}</button>)}
      </div>
      <form onSubmit={publish}>
        {kind === 'reel-file' ? <>
          <label htmlFor="instagram-file">Video file (MP4 or MOV, up to 300 MB)</label>
          <div className="file-row"><input id="instagram-file" readOnly value={filePath} placeholder="No video chosen"/><button type="button" className="outline-button" disabled={busy} onClick={() => void pickFile()}>Choose video</button></div>
          {fileNeedsPageToken && <p className="field-hint">Uploading from this PC needs a Facebook Page token. With your Instagram token, use "Reel from a link".</p>}
        </> : <>
          <label htmlFor="instagram-media">{kind === 'photo' ? 'Public link to a JPEG photo' : 'Public video URL'}</label>
          <input id="instagram-media" type="url" required value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder={kind === 'photo' ? 'https://example.com/photo.jpg' : 'https://example.com/video.mp4'}/>
          <p className="field-hint">Meta downloads the file from this link, so it must open without signing in.</p>
        </>}
        <label htmlFor="instagram-caption">Caption <span>optional</span></label>
        <textarea id="instagram-caption" rows={4} maxLength={CAPTION_LIMIT} value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Write a caption"/>
        <p>Check Instagram before retrying after an interruption; the post might already have been published.</p>
        <button className="primary-button" disabled={busy || !source || fileNeedsPageToken}>{kind === 'photo' ? 'Publish photo' : 'Publish Reel'}</button>
      </form>
      <button className="remove-button disconnect" disabled={busy} onClick={() => void run(async () => { await disconnectInstagram(); setIdentity(null); setMessage('Instagram account disconnected.'); })}>Disconnect Instagram</button>
    </> : <>
      <SetupGuide busy={busy} onOpenDeveloper={() => void run(() => openPlatformAction('instagram', 'developer'))}/>
      <p>Your token is stored in Windows Credential Manager, like your sign-ins.</p>
      <form onSubmit={connect}>
        <label htmlFor="instagram-token">Access token</label>
        <input id="instagram-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="Paste the token from Meta"/>
        <label htmlFor="instagram-id">Instagram account ID <span>only for Facebook Page tokens</span></label>
        <input id="instagram-id" value={accountId} onChange={(event) => setAccountId(event.target.value)} autoComplete="off" placeholder="Numeric professional account ID"/>
        <button className="primary-button" disabled={busy || !token.trim()}>Connect Instagram</button>
      </form>
    </>}
    {busy && <p role="status">Working… uploads and processing can take a few minutes.</p>}
    {message && <p className="success-message" role="status">{message}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
