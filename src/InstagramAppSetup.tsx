import { useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { INSTAGRAM_REDIRECT_URI } from './instagramService';
import { openPlatformAction } from './service';
import { errorText } from './ui';

type Props = { working: boolean; onSave: (appId: string, appSecret: string, configId: string) => Promise<void>; onCancel: () => void };
const COPIED_MS = 2000;

/**
 * Walks through the one-time Meta app setup that Instagram requires before any app can post.
 * New Meta apps only offer "API setup with Unified login", which needs a configuration;
 * its ID is entered with the App ID and secret, all kept in Windows Credential Manager.
 */
export default function InstagramAppSetup({ working, onSave, onCancel }: Props) {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [configId, setConfigId] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const openMeta = () => { setError(''); openPlatformAction('instagram', 'developer').catch((reason) => setError(errorText(reason))); };
  async function copyRedirect() {
    try { await navigator.clipboard.writeText(INSTAGRAM_REDIRECT_URI); setCopied(true); setTimeout(() => setCopied(false), COPIED_MS); }
    catch { setError('Could not copy. Select the address and copy it yourself.'); }
  }
  const ready = appId.trim() && appSecret.trim() && configId.trim();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (working || !ready) return;
    void onSave(appId.trim(), appSecret.trim(), configId.trim()).then(() => setAppSecret(''));
  }
  return <form className="card backup-form instagram-app-setup" onSubmit={submit} aria-label="Set up Instagram once">
    <strong>One-time setup for Instagram</strong>
    <small>Instagram only lets apps post through a free "Meta app" that you own. You set it up once (about 10 minutes), paste three values here, and from then on Connect is one click.</small>
    <ol className="setup-steps">
      <li><b>Make the Instagram account professional.</b> In the Instagram phone app: your profile → ☰ menu → Settings → <em>Account type and tools</em> → <em>Switch to professional account</em> → pick <em>Business</em>.</li>
      <li><b>Create the Meta app.</b> <button type="button" className="text-button" onClick={openMeta}>Open Meta for Developers <ExternalLink size={12}/></button> Press <em>Log in</em> (top right) and sign in with Facebook. The first time, press <em>Get started</em> to register as a developer. Then press <em>My Apps → Create app</em>, name it SocialSpace, choose the use case <em>Manage messaging & content on Instagram</em>, and finish.</li>
      <li><b>Open Unified login.</b> In your app: <em>Use cases</em> → <em>Manage messaging & content on Instagram</em> → <em>Customize</em> → <em>API setup with Unified login</em>.</li>
      <li><b>Add the sign-in address.</b> Under <em>Redirect URL</em>, paste this and press Save:
        <span className="copy-row"><code>{INSTAGRAM_REDIRECT_URI}</code><button type="button" className="ghost-button small-button" onClick={() => void copyRedirect()}>{copied ? <><Check size={12}/> Copied</> : <><Copy size={12}/> Copy</>}</button></span></li>
      <li><b>Create a configuration.</b> Press <em>Create new configuration</em>, name it SocialSpace, choose <em>System-user access token</em> with expiry <em>Never</em>, pick your Instagram account as the asset, and keep the permissions <em>instagram_basic</em> and <em>instagram_content_publish</em>. Copy the <em>Configuration ID</em> it shows.</li>
      <li><b>Copy the App ID and secret.</b> In the left menu: <em>App settings → Basic</em>. Copy the <em>App ID</em> and the <em>App secret</em> (press Show). Use these, not the "Instagram app ID".</li>
    </ol>
    <div className="field-row"><div><label htmlFor="ig-app-id">App ID</label><input id="ig-app-id" inputMode="numeric" autoComplete="off" value={appId} onChange={(event) => setAppId(event.target.value)}/></div>
      <div><label htmlFor="ig-app-secret">App Secret</label><input id="ig-app-secret" type="password" autoComplete="off" value={appSecret} onChange={(event) => setAppSecret(event.target.value)}/></div></div>
    <label htmlFor="ig-config-id">Configuration ID</label><input id="ig-config-id" inputMode="numeric" autoComplete="off" value={configId} onChange={(event) => setConfigId(event.target.value)}/>
    <small>Then press Save and connect. A Facebook window opens: sign in with Facebook or Instagram, choose your Instagram account, and press Allow.</small>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="inline-add"><button className="primary-button small-button" disabled={working || !ready}>Save and connect</button><button type="button" className="ghost-button small-button" onClick={onCancel}>Cancel</button></div>
  </form>;
}
