import { useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { INSTAGRAM_REDIRECT_URI } from './instagramService';
import { openPlatformAction } from './service';
import { errorText } from './ui';

type Props = { working: boolean; onSave: (appId: string, appSecret: string) => Promise<void>; onCancel: () => void };
const COPIED_MS = 2000;

/**
 * Walks through the one-time Meta app setup that Instagram requires before any app can post.
 * Only the App ID and App Secret are entered here; they are stored in Windows Credential Manager.
 */
export default function InstagramAppSetup({ working, onSave, onCancel }: Props) {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const openMeta = () => { setError(''); openPlatformAction('instagram', 'developer').catch((reason) => setError(errorText(reason))); };
  async function copyRedirect() {
    try { await navigator.clipboard.writeText(INSTAGRAM_REDIRECT_URI); setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }
    catch { setError('Could not copy. Select the address and copy it yourself.'); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (working || !appId.trim() || !appSecret.trim()) return;
    void onSave(appId.trim(), appSecret.trim()).then(() => setAppSecret(''));
  }
  return <form className="card backup-form instagram-app-setup" onSubmit={submit} aria-label="Set up Instagram once">
    <strong>One-time setup for Instagram</strong>
    <small>Instagram only lets apps post through a free "Meta app" that you own. You make it once (about 10 minutes), paste two values here, and from then on Connect is one click.</small>
    <ol className="setup-steps">
      <li><b>Make the Instagram account professional.</b> In the Instagram phone app: your profile → ☰ menu → Settings → <em>Account type and tools</em> → <em>Switch to professional account</em> → pick <em>Business</em>.</li>
      <li><b>Create the Meta app.</b> <button type="button" className="text-button" onClick={openMeta}>Open Meta for Developers <ExternalLink size={12}/></button> Sign in with Facebook, press <em>Create app</em>, name it SocialSpace, choose the use case <em>Manage messaging & content on Instagram</em>, and finish.</li>
      <li><b>Allow this app's sign-in address.</b> In your new app, open <em>Instagram → API setup with Instagram login</em>. Under <em>Set up Instagram business login</em>, open <em>Business login settings</em> and paste this under <em>OAuth redirect URIs</em>, then Save:
        <span className="copy-row"><code>{INSTAGRAM_REDIRECT_URI}</code><button type="button" className="ghost-button small-button" onClick={() => void copyRedirect()}>{copied ? <><Check size={12}/> Copied</> : <><Copy size={12}/> Copy</>}</button></span></li>
      <li><b>Add your Instagram account.</b> On the same page, under <em>Generate access tokens</em>, press <em>Add account</em> and sign in as the account you want to post from. If Instagram asks, accept the tester invite.</li>
      <li><b>Copy the two values.</b> At the top of that page, copy the <em>Instagram app ID</em> and the <em>Instagram app secret</em> (press Show), and paste them below.</li>
    </ol>
    <div className="field-row"><div><label htmlFor="ig-app-id">Instagram App ID</label><input id="ig-app-id" inputMode="numeric" autoComplete="off" value={appId} onChange={(event) => setAppId(event.target.value)}/></div>
      <div><label htmlFor="ig-app-secret">Instagram App Secret</label><input id="ig-app-secret" type="password" autoComplete="off" value={appSecret} onChange={(event) => setAppSecret(event.target.value)}/></div></div>
    <small>Then press Save and connect. An Instagram window opens. Sign in if asked and press Allow.</small>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="inline-add"><button className="primary-button small-button" disabled={working || !appId.trim() || !appSecret.trim()}>Save and connect</button><button type="button" className="ghost-button small-button" onClick={onCancel}>Cancel</button></div>
  </form>;
}
