import { getPlatform, normalizeHandle, PLATFORMS, type Account, type Brand, type Platform, type Workspace } from './model';

/**
 * How each social lets one sign-in hold several profiles.
 * New Instagram, TikTok and X presences use a separate account for each brand.
 * YouTube: one Google account can own many channels (Brand Accounts).
 * TikTok and X: every profile is its own account and needs an email no other account there uses.
 */
export const LOGIN_RULES: Record<Platform, { profilesPerLogin: number | null; explain: string }> = {
  instagram: { profilesPerLogin: 1, explain: 'Plan a separate Instagram account for each brand. Confirm availability in Instagram.' },
  youtube: { profilesPerLogin: 100, explain: 'Plan up to 100 YouTube channels per Google account. Confirm existing channels in YouTube.' },
  tiktok: { profilesPerLogin: 1, explain: 'TikTok needs a separate account with its own email for each profile.' },
  x: { profilesPerLogin: 1, explain: 'X needs a separate account with its own email for each profile.' },
  // Pages have no login of their own: they all belong to the SoftWings business portfolio, managed with your own Facebook account.
  facebook: { profilesPerLogin: null, explain: 'Each brand gets a Facebook Page managed through your Facebook login and business portfolio.' },
};

/** Never guess a birthday for a new social account. */
export const DEFAULT_SIGNUP_BIRTHDAY = '';

export const sharesLogins = (platform: Platform) => {
  const limit = LOGIN_RULES[platform].profilesPerLogin;
  // Existing Instagram profiles may still share a login; new plans never attach to one.
  return platform === 'instagram' || limit === null || limit > 1;
};
const emailKey = (email: string | undefined) => (email ?? '').trim().toLowerCase();
/** Gmail plus-addresses and dots are aliases of the same Google account. */
function loginKey(platform: Platform, email: string | undefined): string {
  const key = emailKey(email);
  if (platform !== 'youtube') return key;
  const parts = key.split('@');
  if (parts.length !== 2 || !['gmail.com', 'googlemail.com'].includes(parts[1])) return key;
  return `${parts[0].split('+')[0].replace(/\./g, '')}@gmail.com`;
}

/** A sign-in on one social and the profiles under it. Logins are grouped by sign-up email. */
export type Login = { platform: Platform; email: string; accounts: Account[] };
export function loginsOn(accounts: Account[], platform: Platform): Login[] {
  const groups = new Map<string, Login>();
  for (const account of accounts) {
    const key = loginKey(platform, account.signupEmail);
    if (account.platform !== platform || !key) continue;
    const login = groups.get(key) ?? { platform, email: account.signupEmail!.trim(), accounts: [] };
    login.accounts.push(account);
    groups.set(key, login);
  }
  return [...groups.values()];
}

/** A short, email-safe tag for a brand, e.g. "Massage With Mia" → "massagewithmia". */
export function emailTag(text: string) { return text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) || 'brand'; }

/** base+tag@domain. Gmail, Outlook and most providers deliver plus-addresses to the base inbox. */
export function plusAddress(base: string, tag: string) {
  const [local, domain] = base.trim().split('@');
  if (!local || !domain) return base.trim();
  return `${local.split('+')[0]}+${tag}@${domain}`;
}

/**
 * A profile after its brand is renamed. Profiles not created on the social yet also take the new name
 * as their username and plus-address tag, so a sign-up never goes out under the old name.
 */
export function renamedProfile(account: Account, oldName: string, newName: string): Account {
  const renamed = { ...account, label: newName, ...(account.displayName === oldName ? { displayName: newName } : {}) };
  if (account.status === 'active') return renamed;
  const oldTag = emailTag(oldName);
  const newTag = emailTag(newName);
  const handle = normalizeHandle(account.handle) === oldTag ? newTag : account.handle;
  const [local = '', domain = ''] = (account.signupEmail ?? '').split('@');
  const [base, tag] = local.split('+');
  const signupEmail = domain && tag === oldTag ? `${base}+${newTag}@${domain}` : account.signupEmail;
  return { ...renamed, handle, ...(signupEmail !== undefined ? { signupEmail } : {}) };
}

export type PresencePlan =
  | { mode: 'attach'; platform: Platform; email: string; login: Login; reason: string }
  | { mode: 'new'; platform: Platform; email: string; reason: string };

/**
 * Decides how a brand gets a profile on a social: add it to an existing login that still has room,
 * or plan a new account. New Instagram, TikTok and X accounts get a unique plus-address of the base email.
 */
export function planPresence(accounts: Account[], platform: Platform, brandName: string, baseEmail: string): PresencePlan {
  const name = getPlatform(platform).name;
  const { profilesPerLogin } = LOGIN_RULES[platform];
  const logins = loginsOn(accounts, platform);
  if (platform !== 'instagram' && sharesLogins(platform)) {
    const roomy = logins.filter((login) => profilesPerLogin === null || login.accounts.length < profilesPerLogin);
    const matching = roomy.find((item) => loginKey(platform, item.email) === loginKey(platform, baseEmail));
    // A specified Google account must not be silently replaced by a different saved login.
    const login = matching ?? (platform === 'youtube' && baseEmail.trim() ? undefined : roomy[0]);
    if (login) {
      const saved = login.accounts.length;
      const reason = platform === 'facebook'
        ? `Plan a Page for this brand in your business portfolio. Social Space has ${saved} saved for this login; confirm them in Facebook.`
        : platform === 'youtube'
          ? `Plan a channel under ${login.email}. Social Space has ${saved} saved for this login; confirm the actual count in YouTube.`
          : `Plan to add this profile to ${login.email} (${saved + 1} of ${profilesPerLogin} in your plan). Confirm availability in ${name}.`;
      return { mode: 'attach', platform, email: login.email, login, reason };
    }
  }
  if (platform === 'youtube' && logins.length === 0) {
    const email = baseEmail.trim();
    return { mode: 'attach', platform, email, login: { platform, email, accounts: [] }, reason: `Plan a new channel under your existing Google account ${email}. Confirm its current channel count in YouTube.` };
  }
  // A Gmail plus-address is an alias for the same Google account, not another YouTube login.
  if (platform === 'youtube' && logins.length > 0) {
    const requestedEmail = baseEmail.trim();
    if (requestedEmail && !logins.some((login) => loginKey(platform, login.email) === loginKey(platform, requestedEmail))) {
      return { mode: 'new', platform, email: requestedEmail, reason: 'Plan this channel under the different Google account provided; confirm the account and its channel count in YouTube.' };
    }
    return { mode: 'new', platform, email: '', reason: 'The saved Google logins have reached the 100-channel planning limit. Choose a different Google account; a Gmail plus-address is not a new account.' };
  }
  const used = new Set(accounts.filter((account) => account.platform === platform).map((account) => emailKey(account.signupEmail)));
  // Each new Instagram, TikTok and X account gets a brand address, even when legacy Instagram logins are shared.
  let email = platform !== 'instagram' && sharesLogins(platform) ? baseEmail.trim() : plusAddress(baseEmail, emailTag(brandName));
  if (used.has(emailKey(email))) {
    const tag = emailTag(brandName);
    email = plusAddress(baseEmail, tag);
    for (let n = 2; used.has(emailKey(email)); n += 1) email = plusAddress(baseEmail, `${tag}${n}`);
  }
  const reason = platform === 'facebook'
    ? 'Plan a Facebook Page for this brand in your business portfolio, managed through your Facebook login.'
    : platform !== 'instagram' && sharesLogins(platform)
      ? `Plan a new ${name} login with ${email}; confirm availability on the platform.`
      : `Plan a separate ${name} account with ${email}; this plus-address uses your existing inbox if supported. Confirm the platform accepts it.`;
  return { mode: 'new', platform, email, reason };
}

/** Problems that would stop sign-ups on the socials themselves, so they show before Nate tries. */
export function presenceIssues(accounts: Account[]): { accountId: string; text: string }[] {
  const issues: { accountId: string; text: string }[] = [];
  for (const platform of PLATFORMS.map((item) => item.id)) {
    const name = getPlatform(platform).name;
    for (const login of loginsOn(accounts, platform)) {
      const limit = LOGIN_RULES[platform].profilesPerLogin;
      // Keep previously saved shared Instagram logins usable; the one-per-brand rule applies to new plans.
      if (platform !== 'instagram' && limit !== null && login.accounts.length > limit) for (const account of login.accounts.slice(limit)) {
        issues.push({ accountId: account.id, text: limit === 1
          ? `Another ${name} account already uses ${login.email}. ${name} needs a different email for each account.`
          : `${login.email} has more than the ${limit} ${name} profiles in your Social Space plan. Check the actual count on ${name}.` });
      }
    }
    const handles = new Map<string, string>();
    for (const account of accounts.filter((item) => item.platform === platform)) {
      const handle = normalizeHandle(account.handle).toLowerCase();
      if (!handle) continue;
      if (handles.has(handle)) issues.push({ accountId: account.id, text: `@${account.handle} is used by another ${name} profile here. Each needs its own username.` });
      else handles.set(handle, account.id);
    }
  }
  return issues;
}

export const newBrand = (name: string): Brand => ({ id: crypto.randomUUID(), name: name.trim(), notes: '' });
export const accountsOf = (workspace: Workspace, brandId: string) => workspace.accounts.filter((account) => account.brandId === brandId);

/**
 * Brings any saved workspace up to the brand model. Accounts without a brand join the brand with
 * the same name (accounts made together share their name), or a new one. Safe to run every time.
 */
export function migrateWorkspace(saved: Partial<Workspace>): Workspace {
  const brands = [...(saved.brands ?? [])];
  const byName = new Map(brands.map((brand) => [brand.name.trim().toLowerCase(), brand]));
  const accounts = (saved.accounts ?? []).map((stored) => {
    const account = stored;
    if (account.brandId && brands.some((brand) => brand.id === account.brandId)) return account;
    const name = account.label.trim() || 'Untitled';
    let brand = byName.get(name.toLowerCase());
    if (!brand) { brand = newBrand(name); brands.push(brand); byName.set(name.toLowerCase(), brand); }
    return { ...account, brandId: brand.id };
  });
  const brandIds = new Set(brands.map((brand) => brand.id));
  const categories = (saved.categories ?? []).filter((category) => brandIds.has(category.brandId));
  const series = (saved.series ?? []).filter((item) => brandIds.has(item.brandId));
  const seriesIds = new Set(series.map((item) => item.id));
  const videos = (saved.videos ?? [])
    .filter((video) => categories.some((category) => category.id === video.categoryId && category.brandId === video.brandId))
    .map((video) => video.seriesId && !seriesIds.has(video.seriesId) ? { ...video, seriesId: undefined, episode: undefined } : video);
  // Ticks of profiles that no longer exist are dropped; app-wide ticks ("x:app:plan") stay.
  const ids = new Set(accounts.map((account) => account.id));
  const setup = Object.fromEntries(Object.entries(saved.setup ?? {}).filter(([key]) => /^(instagram|tiktok|youtube|x|facebook):/.test(key) || ids.has(key.split(':')[0])));
  // Every other part (developer logins, anything added later) is kept as it is.
  const { setup: _setup, series: _series, ...rest } = saved;
  return { ...rest, businessName: saved.businessName ?? '', brands, accounts, channels: saved.channels ?? [], categories, videos, ...(Object.keys(setup).length ? { setup } : {}), ...(series.length ? { series } : {}) };
}

/** Where a profile signs in, in plain words: shared with other brands, or its own account. */
export function loginText(account: Account, workspace: Pick<Workspace, 'accounts' | 'brands'>) {
  if (account.platform === 'facebook') return 'This Page is managed through your Facebook login and business portfolio.';
  if (!account.signupEmail) return 'No sign-up email yet.';
  if (!sharesLogins(account.platform)) return `Its own ${getPlatform(account.platform).name} account, signed up with ${account.signupEmail}.`;
  const login = loginsOn(workspace.accounts, account.platform).find((item) => item.accounts.some((other) => other.id === account.id));
  const others = (login?.accounts ?? []).filter((other) => other.id !== account.id).map((other) => workspace.brands.find((brand) => brand.id === other.brandId)?.name ?? other.label);
  return others.length ? `Signs in with ${account.signupEmail}, shared with ${others.join(', ')}.` : `Signs in with ${account.signupEmail}.`;
}

/** Adds back whatever a backup has that this workspace is missing, matched by id. Nothing here is overwritten. */
export function mergeRestored(current: Workspace, backup: Partial<Workspace>): { workspace: Workspace; added: number } {
  const missing = <T extends { id: string }>(mine: T[] = [], theirs: T[] = []) => theirs.filter((item) => !mine.some((own) => own.id === item.id));
  const accounts = missing(current.accounts, backup.accounts);
  const workspace = migrateWorkspace({
    ...current,
    businessName: current.businessName || backup.businessName || '',
    brands: [...current.brands, ...missing(current.brands, backup.brands)],
    accounts: [...current.accounts, ...accounts],
    categories: [...(current.categories ?? []), ...missing(current.categories, backup.categories)],
    videos: [...(current.videos ?? []), ...missing(current.videos, backup.videos)],
  });
  return { workspace, added: accounts.length };
}

/**
 * The accounts whose saved password a profile should share. A profile on a shared login (an Instagram
 * login holding several brands, a Google account holding several channels) uses that login's password.
 * Otherwise it uses its brand's password, taken only from the brand's own logins: never from a login
 * shared with other brands, so one brand's sign-in never leaks into another's.
 */
/**
 * Whether this profile is added to a login another brand already uses (a second Instagram profile, a
 * second YouTube channel). Those are not sign-ups: the social's sign-up page just shows the signed-in
 * account, so the wizard opens the "add a profile" page instead.
 */
export function addsToLogin(all: Account[], account: Account): boolean {
  const key = emailKey(account.signupEmail);
  return sharesLogins(account.platform) && Boolean(key)
    && all.some((other) => other.id !== account.id && other.platform === account.platform && other.brandId !== account.brandId && emailKey(other.signupEmail) === key);
}

export function passwordGroup(all: Account[], account: Account): string[] {
  // A YouTube channel signs in with the main Google account: its password is Google's, typed by Nate,
  // never one the app makes up.
  if (account.platform === 'youtube' || account.platform === 'facebook') return [];
  const key = emailKey(account.signupEmail);
  if (sharesLogins(account.platform) && key) {
    const login = all.filter((item) => item.id !== account.id && item.platform === account.platform && emailKey(item.signupEmail) === key);
    if (login.length) return [...login.map((item) => item.id), account.id];
  }
  const sharedLogin = (item: Account) => sharesLogins(item.platform) && all.some((other) => other.id !== item.id && other.platform === item.platform && other.brandId !== item.brandId && emailKey(other.signupEmail) === emailKey(item.signupEmail));
  const own = all.filter((item) => item.id !== account.id && account.brandId && item.brandId === account.brandId && item.platform !== 'youtube' && !sharedLogin(item))
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
  return [...own.map((item) => item.id), account.id];
}
