import { useEffect, useRef, useState } from 'react';
import { AppWindow, Loader2, Save, Sparkles } from 'lucide-react';
import { BIO_LIMITS, getPlatform, type Account, type Brand, type DeveloperLogin } from './model';
import { cachedProfileCopy, parseKeywords, type ProfileCopy } from './assistant/profileWriter';
import { GhostInput, GhostTextarea } from './GhostText';
import { openProfileEditor } from './postingService';
import { pictureFileFor, profilePicturePath } from './brandImageService';
import { brandLogin } from './useBrowserPosting';
import type { FormFields } from './profileService';
import { BrandMark, errorText } from './ui';
import './brandProfiles.css';

/** A profile's bio and keywords as edited here, saved together. */
export type ProfileDraft = { id: string; bio: string; keywords: string[] };
type Props = {
  brand: Brand;
  /** This brand's profiles, in platform order. */
  accounts: Account[];
  busy: boolean;
  developerLogins?: Record<string, DeveloperLogin>;
  onSave: (drafts: ProfileDraft[], message: string) => Promise<boolean | undefined>;
};
type Draft = { bio: string; keywords: string };

const keywordText = (keywords?: string[]) => (keywords ?? []).join(', ');
const draftOf = (account: Account): Draft => ({ bio: account.bio ?? '', keywords: keywordText(account.keywords) });
const takesKeywords = (account: Account) => account.platform === 'youtube';

/** The values a profile editor gets: the profile's name, this bio and website, and YouTube's keywords. */
export function editorFields(account: Account, brand: Brand, draft: Draft): FormFields {
  const name = (account.displayName || account.label || brand.name).trim();
  const fields: FormFields = { fullName: name, displayName: name, bio: draft.bio.trim(), website: account.website?.trim(), keywords: takesKeywords(account) ? parseKeywords(draft.keywords).join(', ') : undefined };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as FormFields;
}

/**
 * The brand's profile details on every social: Grok suggests each bio and the YouTube keywords (grey, Tab
 * takes them), and Fill opens each social's profile editor in the brand's own window with the picture,
 * name, bio and keywords filled in. Nate checks the page and presses Save there.
 */
export default function BrandProfiles({ brand, accounts, busy, developerLogins, onSave }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(accounts.map((account) => [account.id, draftOf(account)])));
  const [copy, setCopy] = useState<ProfileCopy | null>(null);
  const [writing, setWriting] = useState(false);
  const [working, setWorking] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const asked = useRef('');
  // Profiles added or saved elsewhere show their latest details, keeping what is being typed here.
  const saved = accounts.map((account) => `${account.id}:${account.bio ?? ''}:${keywordText(account.keywords)}`).join('|');
  useEffect(() => {
    setDrafts((current) => Object.fromEntries(accounts.map((account) => [account.id, current[account.id] && isDirty(current[account.id], account) ? current[account.id] : draftOf(account)])));
  }, [saved]);

  const brief = () => ({ brand: brand.name, notes: brand.notes, website: accounts.find((account) => account.website)?.website, platforms: accounts.map((account) => account.platform), current: Object.fromEntries(accounts.map((account) => [account.platform, drafts[account.id]?.bio ?? ''])) });
  async function suggest(fresh: boolean) {
    if (writing || !accounts.length) return;
    setWriting(true); if (fresh) { setError(''); setNote(''); }
    try {
      const next = await cachedProfileCopy(brand.id, brief(), fresh);
      setCopy(next);
      if (fresh) setNote('Grok wrote new suggestions. They show in grey: press Tab in a box to take one.');
    } catch (reason) {
      // Suggestions that load by themselves fail quietly; asking for them says why.
      if (fresh) setError(errorText(reason, 'Grok could not write suggestions. Check the assistant under Settings.'));
    } finally { setWriting(false); }
  }
  // Empty bios or keywords get Grok's suggestions as soon as the panel opens (once per brand while the app runs).
  const missing = accounts.some((account) => !account.bio?.trim() || (takesKeywords(account) && !account.keywords?.length));
  useEffect(() => {
    if (!missing || asked.current === brand.id) return;
    asked.current = brand.id;
    void suggest(false);
  }, [brand.id, missing]);

  const set = (id: string, change: Partial<Draft>) => setDrafts((current) => ({ ...current, [id]: { ...current[id], ...change } }));
  const dirty = accounts.filter((account) => drafts[account.id] && isDirty(drafts[account.id], account));
  const tooLong = accounts.find((account) => (drafts[account.id]?.bio.trim().length ?? 0) > BIO_LIMITS[account.platform]);
  const blocked = busy || Boolean(working);

  async function save() {
    if (!dirty.length) return true;
    if (tooLong) throw new Error(`The ${getPlatform(tooLong.platform).name} bio is longer than ${BIO_LIMITS[tooLong.platform]} characters.`);
    const ok = await onSave(dirty.map((account) => ({ id: account.id, bio: drafts[account.id].bio.trim(), keywords: parseKeywords(drafts[account.id].keywords) })), `Saved the profile details of ${brand.name}.`);
    return ok !== false;
  }
  async function run(label: string, action: () => Promise<void>) {
    if (working) return;
    setWorking(label); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(''); }
  }
  async function fillOne(account: Account) {
    const file = pictureFileFor(account, brand);
    const imagePath = file ? await profilePicturePath(file, account.platform) : undefined;
    await openProfileEditor({ platform: account.platform, brandId: brand.id, ...brandLogin(developerLogins, account), handle: account.handle, fields: editorFields(account, brand, drafts[account.id] ?? draftOf(account)), imagePath });
  }
  const live = accounts.filter((account) => account.status === 'active');
  const fill = (targets: Account[]) => run(targets.length > 1 ? 'all' : targets[0].id, async () => {
    if (!(await save())) return;
    const failed: string[] = [];
    for (const account of targets) {
      try { await fillOne(account); } catch (reason) { failed.push(`${getPlatform(account.platform).name}: ${errorText(reason)}`); }
    }
    const opened = targets.length - failed.length;
    if (opened) setNote(`Opened ${opened === 1 && targets.length === 1 ? getPlatform(targets[0].platform).name : `${opened} profile editors`} signed in as ${brand.name}, with the picture, name and bio filled in. Check each page, then press Save there yourself.`);
    if (failed.length) setError(failed.join(' '));
  });

  if (!accounts.length) return null;
  return <section className="card brand-profiles" aria-labelledby="brand-profiles-title">
    <div className="brand-profiles-head">
      <div>
        <h3 id="brand-profiles-title">Profile details</h3>
        <p>Grok suggests each bio and the YouTube keywords in grey: press Tab to take one, or type your own. Fill opens each social's profile editor as {brand.name} with the brand picture, name and bio filled in, and you press Save there.</p>
      </div>
      <div className="heading-buttons">
        <button type="button" className="ghost-button small-button" disabled={blocked || writing} onClick={() => void suggest(true)}>{writing ? <><Loader2 size={14} className="spin"/> Writing…</> : <><Sparkles size={14}/> {copy ? 'New suggestions' : 'Suggest with Grok'}</>}</button>
        {dirty.length > 0 && <button type="button" className="outline-button small-button" disabled={blocked || Boolean(tooLong)} onClick={() => void run('save', async () => { await save(); })}><Save size={14}/> Save</button>}
        {live.length > 1 && <button type="button" className="primary-button small-button" disabled={blocked || Boolean(tooLong)} onClick={() => void fill(live)}><AppWindow size={14}/> {working === 'all' ? 'Opening…' : `Fill all ${live.length} profiles`}</button>}
      </div>
    </div>
    <ul className="brand-profile-list">{accounts.map((account) => {
      const name = getPlatform(account.platform).name;
      const draft = drafts[account.id] ?? draftOf(account);
      const limit = BIO_LIMITS[account.platform];
      const length = draft.bio.trim().length;
      const bioId = `profile-bio-${account.id}`;
      const keywordsId = `profile-keywords-${account.id}`;
      const suggestedKeywords = copy?.keywords.length ? copy.keywords.join(', ') : undefined;
      return <li key={account.id} className="brand-profile">
        <div className="brand-profile-top">
          <BrandMark platform={account.platform} small/>
          <strong>{name}</strong>{account.handle && <small>@{account.handle.replace(/^@/, '')}</small>}
          <span className="brand-profile-action">{account.status === 'active'
            ? <button type="button" className="outline-button small-button" disabled={blocked || length > limit} onClick={() => void fill([account])}>{working === account.id ? <><Loader2 size={13} className="spin"/> Opening…</> : <><AppWindow size={13}/> Fill on {name}</>}</button>
            : <small className="footnote">Filled in when it's created</small>}</span>
        </div>
        <label htmlFor={bioId}>Bio <span className={`bio-count ${length > limit ? 'over' : ''}`}>{length}/{limit}</span></label>
        <GhostTextarea id={bioId} rows={account.platform === 'youtube' ? 4 : 2} maxLength={1000} value={draft.bio} suggestion={copy?.bios[account.platform]} onAccept={(bio) => set(account.id, { bio })} onChange={(event) => set(account.id, { bio: event.target.value })} placeholder={writing ? 'Grok is writing a suggestion…' : `What ${brand.name} is about on ${name}`}/>
        {takesKeywords(account) && <>
          <label htmlFor={keywordsId}>Channel keywords <span>comma-separated</span></label>
          <GhostInput id={keywordsId} maxLength={600} value={draft.keywords} suggestion={suggestedKeywords} onAccept={(keywords) => set(account.id, { keywords })} onChange={(event) => set(account.id, { keywords: event.target.value })} onBlur={() => set(account.id, { keywords: parseKeywords(draft.keywords).join(', ') })} placeholder="massage, relaxation, self care"/>
        </>}
      </li>;
    })}</ul>
    {note && <p className="success-message" role="status">{note}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}

function isDirty(draft: Draft, account: Account) {
  return draft.bio.trim() !== (account.bio ?? '').trim() || parseKeywords(draft.keywords).join(',') !== (account.keywords ?? []).join(',');
}
