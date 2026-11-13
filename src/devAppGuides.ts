import type { DevProvider } from './devAppsService';
import { INSTAGRAM_REDIRECT_URI } from './instagramService';
import type { FormFields } from './profileService';
import type { SetupPage } from './setupNeeds';
import { TIKTOK_REDIRECT_URI, YOUTUBE_REDIRECT_URI } from './socialConnectService';

/** The callback address X sends approvals to; caught by the app on this port. */
export const X_CALLBACK = 'http://127.0.0.1:49173/callback';
/** A public page of ours that developer portals accept as the app's website. */
export const APP_WEBSITE = 'https://socialspace-review.web.app';

export type KeyField = 'id' | 'secret' | 'config';
/** Something to paste into the developer site, shown with a Copy button. */
export type CopyValue = { label: string; value: string };
export type GuideStep = {
  title: string;
  /** What to press on the site, one instruction per line. Text in *stars* is a label on the site. */
  lines: string[];
  /** The developer page to show for this step. Steps without one keep the page Nate is on. */
  page?: SetupPage;
  copy?: CopyValue[];
  /** Optional steps can be done later without blocking Connect. */
  optional?: boolean;
};
export type DevAppGuide = {
  provider: DevProvider;
  name: string;
  site: string;
  minutes: number;
  steps: GuideStep[];
  /** The values captured from the site on the last step, in order. */
  fields: { key: KeyField; label: string; secret?: boolean }[];
  /** Where on the site the values are, shown with the fields. */
  where: string;
  /** Filled into the developer site's forms as they appear (app name, description, addresses). */
  fill: Pick<FormFields, 'appName' | 'bio' | 'website' | 'redirectUri'>;
};

const APP_NAME = 'SocialSpace';
const APP_DESCRIPTION = 'Publishes videos I make to my own TikTok profiles from my desktop app.';
const TIKTOK_REVIEW_TEXT = 'SocialSpace is a desktop app the owner uses to publish short videos they made to their own TikTok profiles. The owner signs in with Login Kit, picks a video and caption in the app, and the app uploads it with the Content Posting API. It only posts to accounts the owner connects and never reads other users\' data.';
const X_USE_TEXT = 'I use the X API to publish posts I write (text and short videos) to my own brand accounts from my desktop app, SocialSpace. The app only posts on accounts I own after I sign in, does not read or analyze other users\' data, and does not resell or share any X data.';

export const GUIDES: Record<DevProvider, DevAppGuide> = {
  tiktok: {
    provider: 'tiktok', name: 'TikTok', site: 'TikTok for Developers', minutes: 10,
    steps: [
      { title: 'Sign in to TikTok for Developers', page: 'tiktok-login', lines: [
        'Your developer email and password are filled in. Press *Log in*.',
        'If TikTok says the account doesn\'t exist, press *Sign up*: the same email and saved password fill in there. Enter the code TikTok emails you (it shows in Inbox), then accept the developer terms.'] },
      { title: 'Create the app', page: 'tiktok-apps', lines: [
        'Press *Connect an app* (or *Create app*).',
        'Choose *Individual*, name it SocialSpace and press *Confirm*. The app page opens.'] },
      { title: 'Fill in the app details', lines: [
        'Upload an app icon (a square 1024 × 1024 image) and pick a category such as *Entertainment*.',
        'Paste the description below, and add links to your Terms of Service and Privacy Policy pages (TikTok needs both before review).',
        'Under *Platforms*, tick *Desktop*.'],
        copy: [{ label: 'Description', value: APP_DESCRIPTION }, { label: 'Website', value: APP_WEBSITE }] },
      { title: 'Add Login Kit and Content Posting API', lines: [
        'Press *Add products*, add *Login Kit*, then add *Content Posting API*.',
        'In *Content Posting API*, turn on *Direct Post*.'] },
      { title: 'Add the redirect address', lines: [
        'Open *Login Kit*. Under *Redirect URI* for *Desktop*, paste the address below and press *Save*.'],
        copy: [{ label: 'Redirect URI', value: TIKTOK_REDIRECT_URI }] },
      { title: 'Check the scopes', lines: [
        'Under *Scopes*, make sure *user.info.basic*, *user.info.profile* and *video.upload* are added (*video.publish* too, for direct posting).'] },
      { title: 'Submit the app for review', optional: true, lines: [
        'Press *Submit for review* at the top. Paste the explanation below and attach a short screen recording of SocialSpace connecting and posting.',
        'Review takes a few days. Until TikTok approves and audits the app, only its testers can connect and posts stay private. You can connect now and do this later.',
        'To test right away, switch the app to *Sandbox*, add the brand\'s TikTok accounts under *Target users*, and use the Sandbox keys in the next step.'],
        copy: [{ label: 'How the app uses the products', value: TIKTOK_REVIEW_TEXT }] },
      { title: 'Copy the client key and secret', lines: [
        'At the top of the app page, copy the *Client key*, then show and copy the *Client secret*. Paste both below.'] },
    ],
    fields: [{ key: 'id', label: 'Client key' }, { key: 'secret', label: 'Client secret', secret: true }],
    where: 'Top of the app page in TikTok for Developers.',
    fill: { appName: APP_NAME, bio: APP_DESCRIPTION, website: APP_WEBSITE, redirectUri: TIKTOK_REDIRECT_URI },
  },
  google: {
    provider: 'google', name: 'YouTube', site: 'Google Cloud console', minutes: 10,
    steps: [
      { title: 'Create a Google Cloud project', page: 'google-project', lines: [
        'Sign in with Google if it asks (the account that owns the YouTube channels is easiest).',
        'Name the project SocialSpace and press *Create*. Check the new project is picked at the top of the page.'] },
      { title: 'Turn on YouTube Data API v3', page: 'google-youtube-api', lines: [
        'Press *Enable*.'] },
      { title: 'Set up the consent screen', page: 'google-consent', lines: [
        'Press *Get started*. App name SocialSpace, your email as support email, then *Next*.',
        'Audience: *External*. Add your email as contact, agree to the policy and press *Create*.',
        'Open *Audience* → *Test users* → *Add users*, and add the Google account of every YouTube channel you will connect.'] },
      { title: 'Create the desktop client', page: 'google-new-client', lines: [
        'Application type: *Desktop app*. Name it SocialSpace and press *Create*.',
        'Desktop clients accept the app\'s sign-in address without adding anything, so there is no redirect to paste.'],
        copy: [{ label: 'Sign-in address (for reference)', value: YOUTUBE_REDIRECT_URI }] },
      { title: 'Ask for the YouTube audit', page: 'youtube-audit', optional: true, lines: [
        'Videos uploaded from an unaudited project are locked to Private. This Google form asks for the audit, and for more daily quota once brands post daily.',
        'Google also ends test-user connections after 7 days until the consent screen is published (*Audience* → *Publish app*). You can connect now and do this later.'] },
      { title: 'Copy the client ID and secret', page: 'google-credentials', lines: [
        'Under *OAuth 2.0 Client IDs*, open the SocialSpace client. Copy the *Client ID* and the *Client secret* and paste them below.',
        'A downloaded client JSON pasted into Client ID fills in both.'] },
    ],
    fields: [{ key: 'id', label: 'Client ID' }, { key: 'secret', label: 'Client secret', secret: true }],
    where: 'Credentials → OAuth 2.0 Client IDs → SocialSpace.',
    fill: { appName: APP_NAME },
  },
  x: {
    provider: 'x', name: 'X', site: 'X developer portal', minutes: 5,
    steps: [
      { title: 'Sign up as a developer', page: 'x-signup', lines: [
        'Sign in with X if it asks. Choose the free account, paste the use description below, tick the boxes and press *Submit*.',
        'Already have a developer account? Go to the next step.'],
        copy: [{ label: 'Use description', value: X_USE_TEXT }] },
      { title: 'Open your app', page: 'x-portal', lines: [
        'In *Projects & Apps*, open the app X made for you (the free plan has one).'] },
      { title: 'Turn on sign-in with read and write', lines: [
        'Under *User authentication settings*, press *Set up* (or *Edit*).',
        'App permissions: *Read and write*. Type of App: *Native App*.',
        'Paste the callback address and website below, then press *Save*.'],
        copy: [{ label: 'Callback URI', value: X_CALLBACK }, { label: 'Website URL', value: APP_WEBSITE }] },
      { title: 'Copy the client ID', lines: [
        'X shows the *OAuth 2.0 Client ID* and *Client Secret* after saving (later: the app\'s *Keys and tokens* tab). Copy only the *Client ID*; a Native App needs no secret.'] },
    ],
    fields: [{ key: 'id', label: 'OAuth 2.0 Client ID' }],
    where: 'The app\'s Keys and tokens tab → OAuth 2.0 Client ID.',
    fill: { appName: APP_NAME, bio: X_USE_TEXT, website: APP_WEBSITE, redirectUri: X_CALLBACK },
  },
  meta: {
    provider: 'meta', name: 'Instagram', site: 'Meta for Developers', minutes: 10,
    steps: [
      { title: 'Make the Instagram account professional', lines: [
        'In the Instagram phone app: your profile → ☰ menu → *Settings* → *Account type and tools* → *Switch to professional account* → *Business*.',
        'Instagram only lets apps post for professional accounts.'] },
      { title: 'Create the Meta app', page: 'meta-apps', lines: [
        'Press *Log in* and sign in with Facebook. The first time, press *Get started* to register as a developer.',
        'Press *Create app*, name it SocialSpace, choose the use case *Manage messaging & content on Instagram*, and finish.'] },
      { title: 'Open Unified login', lines: [
        'In your app: *Use cases* → *Manage messaging & content on Instagram* → *Customize* → *API setup with Unified login*.'] },
      { title: 'Add the sign-in address', lines: [
        'Under *Redirect URL*, paste the address below and press *Save*.'],
        copy: [{ label: 'Redirect URL', value: INSTAGRAM_REDIRECT_URI }] },
      { title: 'Create a configuration', lines: [
        'Press *Create new configuration*, name it SocialSpace, choose *System-user access token* with expiry *Never*.',
        'Pick your Instagram account as the asset, keep *instagram_basic* and *instagram_content_publish*, and copy the *Configuration ID* it shows.'] },
      { title: 'Copy the App ID and secret', lines: [
        'In the left menu: *App settings* → *Basic*. Copy the *App ID* and the *App secret* (press *Show*). Use these, not the "Instagram app ID".',
        'While the app is in Development mode, every Instagram account you connect needs a role on the app (Instagram Tester).'] },
    ],
    fields: [{ key: 'id', label: 'App ID' }, { key: 'secret', label: 'App secret', secret: true }, { key: 'config', label: 'Configuration ID' }],
    where: 'App settings → Basic, and the Unified login configuration.',
    fill: { appName: APP_NAME, redirectUri: INSTAGRAM_REDIRECT_URI },
  },
};

/** Splits a step line into plain text and *site labels*, which are shown emphasised. */
export function lineParts(line: string): { text: string; label: boolean }[] {
  return line.split(/(\*[^*]+\*)/).filter(Boolean).map((part) => part.startsWith('*') && part.endsWith('*') && part.length > 2
    ? { text: part.slice(1, -1), label: true } : { text: part, label: false });
}

/**
 * Reads what was pasted into the first field. A Google client JSON (downloaded from the console)
 * fills both the ID and the secret; anything else is just trimmed.
 */
export function readPastedKeys(text: string): { id: string; secret?: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, { client_id?: unknown; client_secret?: unknown } | undefined>;
      const client = parsed.installed ?? parsed.web;
      if (client && typeof client.client_id === 'string') {
        return { id: client.client_id.trim(), secret: typeof client.client_secret === 'string' ? client.client_secret.trim() : undefined };
      }
    } catch { /* not JSON after all: keep the text as typed */ }
  }
  return { id: trimmed };
}
