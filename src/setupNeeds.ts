import { getPlatform, PLATFORMS, type Account, type Brand, type Platform } from './model';
import type { DevProvider } from './devAppsService';

/**
 * Everything a brand needs before the app can post for it, per social: the developer app (set up
 * once), the social's own reviews, plans and limits, each profile's account settings, and each
 * profile's connection. Steps the app can see are checked by themselves; the rest are ticked by hand.
 */

/** How a saved connection is doing (from the check_*_connection commands). */
export type ConnectionCheck = { state: 'none' | 'ok' | 'expired' | 'unchecked'; username: string; detail: string };
/** Pages the tracker can open; the desktop app maps each to a fixed address. */
export type SetupPage = 'meta-apps' | 'meta-business' | 'instagram-settings' | 'google-consent' | 'google-youtube-api' | 'google-quota'
  | 'youtube-audit' | 'youtube-verify' | 'tiktok-apps' | 'x-portal' | 'x-products'
  | 'tiktok-login' | 'google-project' | 'google-credentials' | 'google-new-client' | 'x-signup';
export type NeedStatus = 'done' | 'todo' | 'problem' | 'checking';
export type NeedAction = { kind: 'connect'; account: Account } | { kind: 'setup-app'; provider: DevProvider } | { kind: 'sign-in'; account: Account };
export type Need = {
  /** Stable id; manual ticks are saved under it. */
  id: string;
  platform: Platform;
  /** Set on steps that belong to one profile. */
  accountId?: string;
  title: string;
  /** Why it matters, in plain words. */
  why: string;
  status: NeedStatus;
  /** The app cannot see this one: the user ticks it once it's done. */
  manual: boolean;
  /** Nice to have; not counted as needed. */
  optional?: boolean;
  page?: { id: SetupPage; label: string };
  action?: NeedAction;
  /** When a manual step was ticked (ms). */
  markedAt?: number;
};
export type NeedGroup = { platform: Platform; needs: Need[]; open: number };
export type SetupInputs = {
  accounts: Account[];
  brands: Brand[];
  /** Developer app id per provider; null when not set up; undefined while loading. */
  apps?: Partial<Record<DevProvider, string | null>>;
  /** Connection check per profile id; undefined while checking. */
  connections: Record<string, ConnectionCheck | undefined>;
  /** Whether each profile's password is saved; undefined while checking. */
  passwords: Record<string, boolean | undefined>;
  /** Manual ticks: step id → when it was ticked. */
  marks: Record<string, number>;
};

export const PROVIDER_FOR: Record<Platform, DevProvider> = { instagram: 'meta', x: 'x', youtube: 'google', tiktok: 'tiktok' };
const APP_NAME: Record<DevProvider, string> = { meta: 'Meta developer app', x: 'X developer app', google: 'Google Cloud app', tiktok: 'TikTok developer app' };

type ManualStep = { key: string; title: string; why: string; page?: Need['page']; optional?: boolean };

/** Steps on each social's developer side, done once for every brand. */
const APP_STEPS: Record<Platform, ManualStep[]> = {
  instagram: [
    { key: 'roles', title: 'Each Instagram account may use the app', why: 'While the Meta app is in Development mode, only accounts with a role on it (Instagram Tester, accepted from the account) can connect. To skip that for every new brand, put the app Live and pass App Review for instagram_business_content_publish.', page: { id: 'meta-apps', label: 'Open Meta apps' } },
  ],
  youtube: [
    { key: 'api', title: 'YouTube Data API v3 enabled', why: 'The Google project must have the YouTube Data API turned on, or uploads and channel checks fail.', page: { id: 'google-youtube-api', label: 'Open API page' } },
    { key: 'published', title: 'Consent screen published (In production)', why: 'While the Google app is in Testing, only test users can connect and Google ends every connection after 7 days.', page: { id: 'google-consent', label: 'Open consent screen' } },
    { key: 'audit', title: 'YouTube API audit passed', why: 'Videos uploaded through an unaudited API project are locked to Private. The audit (a Google form) makes uploads public and can raise the daily limit.', page: { id: 'youtube-audit', label: 'Open audit form' } },
    { key: 'quota', title: 'Enough daily upload quota', why: 'The default 10,000 units a day is about 6 uploads a day across all channels. Ask for more in the audit form once brands post daily.', page: { id: 'google-quota', label: 'Open quotas' }, optional: true },
  ],
  tiktok: [
    { key: 'review', title: 'App approved by TikTok', why: 'TikTok reviews the app (Login Kit and Content Posting API) before accounts other than its testers can connect.', page: { id: 'tiktok-apps', label: 'Open TikTok apps' } },
    { key: 'audit', title: 'Content Posting audit passed', why: 'Until TikTok audits the app, everything it posts is private (only the account can see it). After the audit, posts can be public.', page: { id: 'tiktok-apps', label: 'Open TikTok apps' } },
  ],
  x: [
    { key: 'auth', title: 'Read and write access turned on', why: 'In the app\'s User authentication settings: Native App, permissions Read and write, and the callback address the app shows. Without write access, posting fails.', page: { id: 'x-portal', label: 'Open X portal' } },
    { key: 'plan', title: 'Developer plan that allows enough posts', why: 'X limits how many posts the API may make on each plan, and the free plan is very small. Check the plan covers every brand\'s posts each month.', page: { id: 'x-products', label: 'Open X plans' } },
  ],
};

/** Account settings each profile needs on its social, which the app cannot see. */
const PROFILE_STEPS: Partial<Record<Platform, ManualStep[]>> = {
  instagram: [
    { key: 'professional', title: 'Professional account (Business or Creator)', why: 'Instagram only lets apps post for professional accounts. Switch in Instagram settings → Account type and tools.', page: { id: 'instagram-settings', label: 'Open Instagram' } },
    { key: 'page', title: 'Linked to a Facebook Page or business portfolio', why: 'Meta only shares an Instagram account with the app when it is linked to a Facebook Page or business portfolio you manage. Without it Meta connects "no Instagram account".', page: { id: 'meta-business', label: 'Open business settings' } },
  ],
  youtube: [
    { key: 'verified', title: 'Channel verified by phone', why: 'Needed for custom thumbnails and videos over 15 minutes.', page: { id: 'youtube-verify', label: 'Open verification' }, optional: true },
  ],
};

const manualNeed = (id: string, platform: Platform, step: ManualStep, marks: Record<string, number>, accountId?: string, prefix = ''): Need => ({
  id, platform, accountId, title: prefix + step.title, why: step.why, status: marks[id] ? 'done' : 'todo', manual: true, optional: step.optional, page: step.page, markedAt: marks[id],
});

/** Everything needed for posting, grouped by social, for the profiles given. */
export function setupNeeds({ accounts, brands, apps, connections, passwords, marks }: SetupInputs): NeedGroup[] {
  const brandName = (account: Account) => brands.find((brand) => brand.id === account.brandId)?.name ?? account.label;
  return PLATFORMS.filter((platform) => accounts.some((account) => account.platform === platform.id)).map(({ id: platform, name }) => {
    const provider = PROVIDER_FOR[platform];
    const appId = apps?.[provider];
    const needs: Need[] = [{
      id: `${platform}:app`, platform, title: `${APP_NAME[provider]} set up in Social Space`, manual: false,
      why: `Every ${name} profile connects through one developer app. Its keys are saved once, in Windows Credential Manager.`,
      status: apps === undefined ? 'checking' : appId ? 'done' : 'todo', action: { kind: 'setup-app', provider },
    }];
    needs.push(...APP_STEPS[platform].map((step) => manualNeed(`${platform}:app:${step.key}`, platform, step, marks)));
    for (const account of accounts.filter((item) => item.platform === platform).sort((a, b) => brandName(a).localeCompare(brandName(b)))) {
      const who = `${brandName(account)}${account.handle ? ` (@${account.handle})` : ''}: `;
      if (account.status !== 'active') {
        needs.push({ id: `${account.id}:created`, platform, accountId: account.id, title: `${who}profile created on ${name}`, why: 'Create it from the brand\'s Profiles, or press "I already made it" there.', status: 'todo', manual: false });
        continue;
      }
      const saved = passwords[account.id];
      needs.push({ id: `${account.id}:sign-in`, platform, accountId: account.id, title: `${who}username and password saved`, why: 'Kept in Windows Credential Manager and in the encrypted backup, so the sign-in is never lost.', status: saved === undefined ? 'checking' : saved ? 'done' : 'todo', manual: false, action: { kind: 'sign-in', account } });
      needs.push(...(PROFILE_STEPS[platform] ?? []).map((step) => manualNeed(`${account.id}:${step.key}`, platform, step, marks, account.id, who)));
      const check = connections[account.id];
      needs.push({
        id: `${account.id}:connected`, platform, accountId: account.id, title: `${who}connected for posting`, manual: false, action: { kind: 'connect', account },
        why: !check ? 'Checking the connection…'
          : check.state === 'ok' ? `Connected${check.username ? ` as @${check.username.replace(/^@/, '')}` : ''}. ${check.detail || 'Renews by itself.'}`
          : check.state === 'none' ? `Connect it so the app can post as this ${name} profile.`
          : check.detail,
        status: !check ? 'checking' : check.state === 'ok' ? 'done' : check.state === 'none' ? 'todo' : 'problem',
      });
    }
    return { platform, needs, open: needs.filter((need) => (need.status === 'todo' || need.status === 'problem') && !need.optional).length };
  });
}

/** How many required steps are still open across every social. */
export const openCount = (groups: NeedGroup[]) => groups.reduce((sum, group) => sum + group.open, 0);
export const platformName = (platform: Platform) => getPlatform(platform).name;
