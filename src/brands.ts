import { getPlatform, normalizeHandle, PLATFORMS, type Account, type Brand, type Platform, type Workspace } from './model';

/**
 * How each social lets one sign-in hold several profiles.
 * Instagram: up to 5 profiles can share one email and switch under one login (each needs its own username).
 * YouTube: one Google account can own many channels (Brand Accounts).
 * TikTok and X: every profile is its own account and needs an email no other account there uses.
 */
export const LOGIN_RULES: Record<Platform, { profilesPerLogin: number; explain: string }> = {
  instagram: { profilesPerLogin: 5, explain: 'Instagram lets up to 5 profiles share one email and login.' },
  youtube: { profilesPerLogin: 100, explain: 'YouTube channels live under one Google account as Brand Accounts.' },
  tiktok: { profilesPerLogin: 1, explain: 'TikTok needs a separate account with its own email for each profile.' },
  x: { profilesPerLogin: 1, explain: 'X needs a separate account with its own email for each profile.' },
};

/** Sign-up forms (TikTok, Instagram, X, Google) all ask for a birthday; brands use this one unless changed. */
export const DEFAULT_SIGNUP_BIRTHDAY = '1983-06-05';
/** The default before 0.8.0. Profiles not created yet that still carry it move to the current default. */
const OLD_DEFAULT_BIRTHDAY = '1995-06-15';

export const sharesLogins = (platform: Platform) => LOGIN_RULES[platform].profilesPerLogin > 1;
const emailKey = (email: string | undefined) => (email ?? '').trim().toLowerCase();

/** A sign-in on one social and the profiles under it. Logins are grouped by sign-up email. */
export type Login = { platform: Platform; email: string; accounts: Account[] };
export function loginsOn(accounts: Account[], platform: Platform): Login[] {
  const groups = new Map<string, Login>();
  for (const account of accounts) {
    const key = emailKey(account.signupEmail);
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
 * or plan a new account. New accounts on TikTok and X get a unique plus-address of the base email.
 */
export function planPresence(accounts: Account[], platform: Platform, brandName: string, baseEmail: string): PresencePlan {
  const name = getPlatform(platform).name;
  const { profilesPerLogin } = LOGIN_RULES[platform];
  const logins = loginsOn(accounts, platform);
  if (sharesLogins(platform)) {
    const roomy = logins.filter((login) => login.accounts.length < profilesPerLogin);
    const login = roomy.find((item) => emailKey(item.email) === emailKey(baseEmail)) ?? roomy[0];
    if (login) {
      const count = platform === 'youtube' ? `${login.accounts.length} ${login.accounts.length === 1 ? 'channel' : 'channels'} there now` : `${login.accounts.length + 1} of ${profilesPerLogin} profiles`;
      return { mode: 'attach', platform, email: login.email, login, reason: `Adds to your ${name} login ${login.email} (${count}).` };
    }
  }
  const used = new Set(accounts.filter((account) => account.platform === platform).map((account) => emailKey(account.signupEmail)));
  let email = baseEmail.trim();
  if (used.has(emailKey(email))) {
    const tag = emailTag(brandName);
    email = plusAddress(baseEmail, tag);
    for (let n = 2; used.has(emailKey(email)); n += 1) email = plusAddress(baseEmail, `${tag}${n}`);
  }
  return { mode: 'new', platform, email, reason: sharesLogins(platform) ? `New ${name} login with ${email}.` : `New ${name} account with its own email ${email}.` };
}

/** Problems that would stop sign-ups on the socials themselves, so they show before Nate tries. */
export function presenceIssues(accounts: Account[]): { accountId: string; text: string }[] {
  const issues: { accountId: string; text: string }[] = [];
  for (const platform of PLATFORMS.map((item) => item.id)) {
    const name = getPlatform(platform).name;
    for (const login of loginsOn(accounts, platform)) {
      const limit = LOGIN_RULES[platform].profilesPerLogin;
      if (login.accounts.length > limit) for (const account of login.accounts.slice(limit)) {
        issues.push({ accountId: account.id, text: limit === 1 ? `Another ${name} account already uses ${login.email}. ${name} needs a different email for each account.` : `${login.email} already has ${limit} ${name} profiles, the most one login allows.` });
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
    let account = stored;
    if (account.status !== 'active' && account.birthday === OLD_DEFAULT_BIRTHDAY) account = { ...account, birthday: DEFAULT_SIGNUP_BIRTHDAY };
    if (account.brandId && brands.some((brand) => brand.id === account.brandId)) return account;
    const name = account.label.trim() || 'Untitled';
    let brand = byName.get(name.toLowerCase());
    if (!brand) { brand = newBrand(name); brands.push(brand); byName.set(name.toLowerCase(), brand); }
    return { ...account, brandId: brand.id };
  });
  const brandIds = new Set(brands.map((brand) => brand.id));
  const categories = (saved.categories ?? []).filter((category) => brandIds.has(category.brandId));
  const videos = (saved.videos ?? []).filter((video) => categories.some((category) => category.id === video.categoryId && category.brandId === video.brandId));
  // Ticks of profiles that no longer exist are dropped; app-wide ticks ("x:app:plan") stay.
  const ids = new Set(accounts.map((account) => account.id));
  const setup = Object.fromEntries(Object.entries(saved.setup ?? {}).filter(([key]) => /^(instagram|tiktok|youtube|x):/.test(key) || ids.has(key.split(':')[0])));
  return { businessName: saved.businessName ?? '', brands, accounts, channels: saved.channels ?? [], categories, videos, ...(Object.keys(setup).length ? { setup } : {}) };
}

/** Where a profile signs in, in plain words: shared with other brands, or its own account. */
export function loginText(account: Account, workspace: Pick<Workspace, 'accounts' | 'brands'>) {
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
