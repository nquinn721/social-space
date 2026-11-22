import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, ImagePlus, Loader2, RotateCcw, Sparkles, Wand2, X as Close } from 'lucide-react';
import { getPlatform, normalizeHandle, type Account, type Brand, type BrandImage, type View } from './model';
import { buildPrompt, buildRefinePrompt, pictureIdeaFor, STYLES, suggestStyle, type BrandContext, type ImageStyle } from './imageAiService';
import { BANNER, bannerPrompt, brandImagePreview, generatePictures, keepBanner, keepFile, keepSquare, pictureFileFor, PROFILE_SIZES, profilePicturePath, revealBrandImage, type Aspect, type GeneratedImage } from './brandImageService';
import { chooseImageFile } from './profileService';
import { brandLogin, openProfileEditor } from './brandWindowService';

import { AccountAvatar, BrandMark, errorText } from './ui';
import './imageStudio.css';
import './brandPicture.css';

const TAKES = 4;
const MAX_TAKES_KEPT = 12;

/** Shows a stored brand picture; empty while it hasn't arrived on this PC. */
export function useBrandPicture(file?: string) {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    let live = true;
    setPreview('');
    if (file) brandImagePreview(file).then((value) => { if (live) setPreview(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [file]);
  return preview;
}

/** The brand's picture when it has one, otherwise its lead profile's picture or initial. */
export function BrandAvatar({ brand, lead }: { brand: Brand; lead?: Account }) {
  const preview = useBrandPicture(brand.image?.file);
  return preview ? <span className="avatar lg" aria-hidden="true"><img src={preview} alt=""/></span> : <AccountAvatar account={lead} name={brand.name} size="lg"/>;
}

type Target = { kind: 'brand' } | { kind: 'banner' } | { kind: 'account'; account: Account };

/**
 * Makes pictures with Grok Imagine: describe, generate four takes, pick one, refine it, use it.
 * Square for profile pictures, 16:9 for a YouTube banner. Uses the xAI key of the Grok video source.
 */
export function PictureStudio({ title, aspect, initial, context, style: startStyle = context ? suggestStyle(context) : 'logo', busy, onUse, onClose, onNeedKey }: { title: string; aspect: Aspect; initial: string; context?: BrandContext; style?: ImageStyle; busy: boolean; onUse: (preview: string, prompt: string) => Promise<void>; onClose: () => void; onNeedKey?: () => void }) {
  const [description, setDescription] = useState(initial);
  const [style, setStyle] = useState<ImageStyle>(startStyle);
  const [refinement, setRefinement] = useState('');
  const [takes, setTakes] = useState<(GeneratedImage & { prompt: string })[]>([]);
  const [selected, setSelected] = useState(0);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  const current = takes[selected];
  const wide = aspect === '16:9';
  const blocked = Boolean(working) || busy;
  useEffect(() => { panel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, []);

  async function run(label: string, action: () => Promise<void>) {
    if (working) return;
    setWorking(label); setError('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(''); }
  }
  const promptFor = () => wide ? description.trim() : buildPrompt(description, style, [], context);
  const generate = () => run(`Making ${TAKES} takes with Grok, about 10 to 30 seconds…`, async () => {
    const prompt = promptFor();
    const made = await generatePictures({ prompt, count: TAKES, aspect });
    setTakes((list) => [...made.map((image) => ({ ...image, prompt })), ...list].slice(0, MAX_TAKES_KEPT));
    setSelected(0);
  });
  const refine = () => run('Refining with Grok, about 10 to 20 seconds…', async () => {
    if (!current) return;
    const prompt = wide ? `Keep this banner the same, but ${refinement.trim()}. No text, no watermark.` : buildRefinePrompt(refinement, style, context);
    const made = await generatePictures({ prompt, count: 1, aspect, sourcePath: current.path });
    setTakes((list) => [...made.map((image) => ({ ...image, prompt })), ...list].slice(0, MAX_TAKES_KEPT));
    setSelected(0); setRefinement('');
  });
  const use = () => run('Saving…', async () => { if (current) await onUse(current.preview, current.prompt); });

  return <section ref={panel} className={`image-studio picture-studio ${wide ? 'wide' : ''}`} aria-label={title}>
    <header className="studio-head">
      <h4><Sparkles size={15}/> {title}</h4>
      <span className="studio-sub">Grok Imagine from xAI makes {TAKES} takes to pick from.</span>
      <button type="button" className="icon-button" aria-label="Close picture maker" disabled={Boolean(working)} onClick={onClose}><Close size={16}/></button>
    </header>
    <div className="studio-controls">
      <label htmlFor={`studio-${aspect}`}>Describe the picture</label>
      <textarea id={`studio-${aspect}`} rows={3} maxLength={600} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={wide ? 'e.g. soft pastel meadow with bunnies along the middle' : 'e.g. cute cartoon bunny face, pastel colors'}/>
      {!wide && <div className="studio-options"><div className="segmented" role="group" aria-label="Style">{STYLES.map((item) => <button key={item.id} type="button" aria-pressed={style === item.id} onClick={() => setStyle(item.id)}>{item.label}</button>)}</div></div>}
      <div className="studio-actions"><button type="button" className="primary-button" disabled={blocked || !description.trim()} onClick={() => void generate()}><Wand2 size={15}/> {takes.length ? `Make ${TAKES} more` : `Make ${TAKES} takes`}</button></div>
    </div>
    {takes.length > 0 && <div className="takes" role="group" aria-label="Takes">{takes.map((take, index) => <button key={take.path} type="button" className={index === selected ? 'selected' : ''} aria-label={`Take ${takes.length - index}`} aria-pressed={index === selected} onClick={() => setSelected(index)}><img src={take.preview} alt=""/></button>)}</div>}
    {current && <div className="take-actions">
      <button type="button" className="primary-button" disabled={blocked} onClick={() => void use()}><Check size={15}/> Use this {wide ? 'banner' : 'picture'}</button>
      <div className="idea-row"><label htmlFor={`refine-${aspect}`} className="sr-only">Change this take</label><input id={`refine-${aspect}`} maxLength={300} value={refinement} onChange={(event) => setRefinement(event.target.value)} placeholder="Change it: e.g. warmer colors, add a bow" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (refinement.trim() && !blocked) void refine(); } }}/>
        <button type="button" className="outline-button" disabled={blocked || !refinement.trim()} onClick={() => void refine()}><Sparkles size={14}/> Refine</button></div>
    </div>}
    {working && <p className="studio-working" role="status"><Loader2 size={14} className="spin"/> {working}</p>}
    {error && <div className="error-message" role="alert">{error}{onNeedKey && /xAI key/.test(error) && <> <button type="button" className="ghost-button small-button" onClick={onNeedKey}>Open Video sources</button></>}</div>}
  </section>;
}

function Round({ file, name, size = 56 }: { file?: string; name: string; size?: number }) {
  const preview = useBrandPicture(file);
  return <span className="picture-round" style={{ width: size, height: size }} aria-hidden="true">{preview ? <img src={preview} alt=""/> : file ? <Loader2 size={14} className="spin"/> : name.trim().charAt(0).toUpperCase() || '?'}</span>;
}

type Props = {
  brand: Brand;
  accounts: Account[];
  busy: boolean;
  onSaveImage: (image: BrandImage | undefined, message: string) => Promise<unknown>;
  onSaveAccountImage: (account: Account, file: string | undefined, message: string) => Promise<unknown>;
  onNavigate?: (view: View, section?: string) => void;
};

/**
 * The brand's picture, made with Grok and used on every profile of the brand by default.
 * Each social can have its own instead. Putting it on a live profile opens that social's profile
 * settings for review; X requires choosing the picture manually.
 */
export default function BrandPicture({ brand, accounts, busy, onSaveImage, onSaveAccountImage, onNavigate }: Props) {
  const [target, setTarget] = useState<Target | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const image = brand.image;
  const bannerPreview = useBrandPicture(image?.banner);
  const blocked = busy || working;
  const youtube = accounts.find((account) => account.platform === 'youtube');
  // The brand's own words (name, handle, bio, notes) shape every picture made for it.
  const lead = accounts.find((account) => account.bio?.trim()) ?? accounts[0];
  const context: BrandContext = { name: brand.name, displayName: lead?.displayName, handle: lead?.handle, bio: lead?.bio, notes: brand.notes };
  const startIdea = pictureIdeaFor({ ...context, displayName: undefined }) || brand.name;

  async function run(action: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  // A picture chosen or generated in the New brand sign-up becomes the brand's picture, so it syncs.
  const adopted = useRef('');
  useEffect(() => {
    const legacy = accounts.find((account) => account.imagePath)?.imagePath;
    if (image?.file || !legacy || adopted.current === brand.id) return;
    adopted.current = brand.id;
    void keepFile(legacy).then((file) => onSaveImage({ file }, `${brand.name}'s sign-up picture is now its brand picture.`)).catch(() => undefined);
  }, [brand.id, image?.file]);

  const useSquare = (preview: string, prompt: string) => (async () => {
    if (!target) return;
    const file = await keepSquare(preview);
    if (target.kind === 'account') {
      await onSaveAccountImage(target.account, file, `${getPlatform(target.account.platform).name} now has its own picture.`);
    } else {
      await onSaveImage({ ...image, file, prompt }, `New picture for ${brand.name}. Every profile uses it unless it has its own.`);
    }
    setTarget(null);
  })();
  const useBanner = (preview: string) => (async () => {
    if (!image?.file) return;
    const banner = await keepBanner(preview);
    await onSaveImage({ ...image, banner }, `New YouTube banner for ${brand.name}.`);
    setTarget(null);
  })();
  const choose = (account?: Account) => run(async () => {
    const path = await chooseImageFile();
    if (!path) return;
    const file = await keepFile(path);
    if (account) await onSaveAccountImage(account, file, `${getPlatform(account.platform).name} now has its own picture.`);
    else await onSaveImage({ ...image, file }, `New picture for ${brand.name}.`);
  });
  const putOn = (account: Account) => run(async () => {
    const file = pictureFileFor(account, brand);
    if (!file) return;
    const path = await profilePicturePath(file, account.platform);
    // The brand's own window (its signed-in folder), so the picture lands on this brand's profile and
    // a sign-in page there fills the brand's login.
    await openProfileEditor({ platform: account.platform, brandId: brand.id, ...brandLogin(account), handle: normalizeHandle(account.handle), fields: {}, imagePath: path });
    setNote(account.platform === 'x' ? 'Opened X profile settings. Choose your picture and save it on X yourself.' : `Opened ${getPlatform(account.platform).name} profile settings with the picture filled in (${PROFILE_SIZES[account.platform]} x ${PROFILE_SIZES[account.platform]}). Check the crop there, then press Save on the page.${account.platform === 'youtube' && image?.banner ? ' For the banner: on Branding press Upload under Banner image and pick the file Show banner file selects.' : ''}`);
  });
  const showBanner = () => run(async () => { if (image?.banner) await revealBrandImage(image.banner); });
  const needKey = onNavigate ? () => onNavigate('settings', 'grok') : undefined;
  const studioFor = (what: Target) => setTarget((open) => open && open.kind === what.kind && (open.kind !== 'account' || what.kind !== 'account' || open.account.id === what.account.id) ? null : what);

  return <section className="card brand-picture" aria-labelledby="brand-picture-title">
    <div className="brand-picture-head">
      <Round file={image?.file} name={brand.name} size={84}/>
      <div className="brand-picture-text">
        <h3 id="brand-picture-title">Brand picture</h3>
        <p>{image?.file ? 'Every profile of this brand uses it unless you give one its own. It syncs to your partner\'s app.' : 'Make one picture for every profile: Instagram, TikTok, YouTube and X.'}</p>
        <div className="heading-buttons">
          <button type="button" className="primary-button small-button" disabled={blocked} aria-expanded={target?.kind === 'brand'} onClick={() => studioFor({ kind: 'brand' })}><Wand2 size={14}/> {image?.file ? 'Make a new one' : 'Generate with Grok'}</button>
          <button type="button" className="outline-button small-button" disabled={blocked} onClick={() => void choose()}><ImagePlus size={14}/> Choose a file</button>
        </div>
        {image?.file && accounts.some((account) => account.status === 'active') && <div className="picture-put-on"><span>Put it on</span>{accounts.filter((account) => account.status === 'active').map((account) => <button key={account.id} type="button" className="outline-button small-button" disabled={blocked || !pictureFileFor(account, brand)} aria-label={`Put on ${getPlatform(account.platform).name}`} title={account.platform === 'x' ? 'Open X profile settings and choose the picture yourself' : `Opens ${getPlatform(account.platform).name} profile settings with the picture filled in`} onClick={() => void putOn(account)}><BrandMark platform={account.platform} small/> {getPlatform(account.platform).name}</button>)}</div>}
      </div>
    </div>
    {target?.kind === 'brand' && <PictureStudio key="brand" title={`Picture for ${brand.name}`} aspect="1:1" initial={startIdea} context={context} busy={blocked} onUse={useSquare} onClose={() => setTarget(null)} onNeedKey={needKey}/>}

    {image?.file && youtube && <div className="banner-row">
      <div className="banner-frame" aria-label="YouTube banner preview">{bannerPreview ? <img src={bannerPreview} alt=""/> : <span>{image.banner ? 'Banner is on its way from your partner\'s app' : 'No YouTube banner yet'}</span>}<i className="safe-area" title={`Shown on every device: the centre ${BANNER.safeWidth} x ${BANNER.safeHeight}`}/></div>
      <div className="banner-text"><strong>YouTube banner</strong><small>{BANNER.width} x {BANNER.height}. The outlined middle shows on phones, TVs and computers.</small>
        <div className="heading-buttons">
          <button type="button" className="outline-button small-button" disabled={blocked} aria-expanded={target?.kind === 'banner'} onClick={() => studioFor({ kind: 'banner' })}><Wand2 size={14}/> {image.banner ? 'New banner' : 'Make a banner'}</button>
          {image.banner && <button type="button" className="ghost-button small-button" disabled={blocked} onClick={() => void showBanner()}><FolderOpen size={14}/> Show banner file</button>}
        </div></div>
    </div>}
    {target?.kind === 'banner' && <PictureStudio key="banner" title="YouTube banner" aspect="16:9" initial={bannerPrompt(brand.name, image?.prompt ?? '')} busy={blocked} onUse={(preview) => useBanner(preview)} onClose={() => setTarget(null)} onNeedKey={needKey}/>}

    {accounts.length > 0 && <details className="picture-own" open={target?.kind === 'account' || accounts.some((account) => account.imageFile) || undefined}>
    <summary>Picture per social <small>{accounts.filter((account) => account.imageFile).length ? `${accounts.filter((account) => account.imageFile).length} with their own` : 'all use the brand picture'}</small></summary>
    <ul className="picture-socials">{accounts.map((account) => {
      const own = Boolean(account.imageFile);
      const file = pictureFileFor(account, brand);
      const name = getPlatform(account.platform).name;
      const open = target?.kind === 'account' && target.account.id === account.id;
      return <li key={account.id}>
        <div className="picture-social">
          <Round file={file} name={brand.name} size={40}/>
          <BrandMark platform={account.platform} small/>
          <div className="picture-social-text"><strong>{name}</strong><small>{own ? 'Its own picture' : file ? 'Brand picture' : 'No picture yet'} · {PROFILE_SIZES[account.platform]} px</small></div>
          <div className="picture-social-actions">
            {account.status !== 'active' && <small className="footnote">Used when it's created</small>}
            <button type="button" className="ghost-button small-button" disabled={blocked} aria-expanded={open} onClick={() => studioFor({ kind: 'account', account })}><Wand2 size={13}/> Own picture</button>
            <button type="button" className="ghost-button small-button" disabled={blocked} onClick={() => void choose(account)}><ImagePlus size={13}/><span className="sr-only">Choose a file for {name}</span></button>
            {own && <button type="button" className="ghost-button small-button" disabled={blocked} onClick={() => void run(async () => { await onSaveAccountImage(account, undefined, `${name} uses the brand picture again.`); })}><RotateCcw size={13}/> Use brand picture</button>}
          </div>
        </div>
        {open && <PictureStudio key={account.id} title={`Own picture for ${name}`} aspect="1:1" initial={startIdea} context={context} busy={blocked} onUse={useSquare} onClose={() => setTarget(null)} onNeedKey={needKey}/>}
      </li>;
    })}</ul></details>}
    {youtube && image?.banner && youtube.status !== 'active' && <p className="footnote">The banner goes on YouTube once the channel is created.</p>}
    {working && <p className="studio-working" role="status"><Loader2 size={14} className="spin"/> Working…</p>}
    {note && <p className="success-message" role="status">{note}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
