import { useEffect, useRef, useState } from 'react';
import { AppWindow, Check, FolderOpen, ImagePlus, Loader2, RotateCcw, Sparkles, Wand2, X as Close } from 'lucide-react';
import { getPlatform, normalizeHandle, type Account, type Brand, type BrandImage, type View } from './model';
import { buildPrompt, buildRefinePrompt, STYLES, type ImageStyle } from './imageAiService';
import { BANNER, bannerPrompt, brandImagePreview, geminiKeyStatus, generateGeminiImages, keepBanner, keepFile, keepSquare, pictureFileFor, PROFILE_SIZES, profilePicturePath, revealBrandImage, type Aspect, type GeneratedImage } from './brandImageService';
import { chooseImageFile, fillSiteForm, openPlatformWindow } from './profileService';
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
 * Makes pictures with Gemini: describe, generate four takes, pick one, refine it, use it.
 * Square for profile pictures, 16:9 for a YouTube banner.
 */
export function GeminiStudio({ title, aspect, initial, style: startStyle = 'logo', busy, onUse, onClose, onNeedKey }: { title: string; aspect: Aspect; initial: string; style?: ImageStyle; busy: boolean; onUse: (preview: string, prompt: string) => Promise<void>; onClose: () => void; onNeedKey?: () => void }) {
  const [description, setDescription] = useState(initial);
  const [style, setStyle] = useState<ImageStyle>(startStyle);
  const [refinement, setRefinement] = useState('');
  const [takes, setTakes] = useState<(GeneratedImage & { prompt: string })[]>([]);
  const [selected, setSelected] = useState(0);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const panel = useRef<HTMLElement>(null);
  const current = takes[selected];
  const wide = aspect === '16:9';
  const blocked = Boolean(working) || busy;
  useEffect(() => { panel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); void geminiKeyStatus().then(setHasKey).catch(() => setHasKey(false)); }, []);

  async function run(label: string, action: () => Promise<void>) {
    if (working) return;
    setWorking(label); setError('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(''); }
  }
  const promptFor = () => wide ? description.trim() : buildPrompt(description, style);
  const generate = () => run(`Making ${TAKES} takes with Gemini, about 10 to 30 seconds…`, async () => {
    const prompt = promptFor();
    const made = await generateGeminiImages({ prompt, count: TAKES, aspect });
    setTakes((list) => [...made.map((image) => ({ ...image, prompt })), ...list].slice(0, MAX_TAKES_KEPT));
    setSelected(0);
  });
  const refine = () => run('Refining with Gemini, about 10 to 20 seconds…', async () => {
    if (!current) return;
    const prompt = wide ? `Keep this banner the same, but ${refinement.trim()}. No text, no watermark.` : buildRefinePrompt(refinement, style);
    const made = await generateGeminiImages({ prompt, count: 1, aspect, sourcePath: current.path });
    setTakes((list) => [...made.map((image) => ({ ...image, prompt })), ...list].slice(0, MAX_TAKES_KEPT));
    setSelected(0); setRefinement('');
  });
  const use = () => run('Saving…', async () => { if (current) await onUse(current.preview, current.prompt); });

  return <section ref={panel} className={`image-studio gemini-studio ${wide ? 'wide' : ''}`} aria-label={title}>
    <header className="studio-head">
      <h4><Sparkles size={15}/> {title}</h4>
      <span className="studio-sub">Gemini from Google makes {TAKES} takes to pick from.</span>
      <button type="button" className="icon-button" aria-label="Close picture maker" disabled={Boolean(working)} onClick={onClose}><Close size={16}/></button>
    </header>
    {hasKey === false && <div className="status-line off" role="status"><span className="dot"/><span>Add your Gemini API key under Settings &gt; Pictures first. Get one at aistudio.google.com.</span>{onNeedKey && <button type="button" className="ghost-button small-button" onClick={onNeedKey}>Open Settings</button>}</div>}
    <div className="studio-controls">
      <label htmlFor={`studio-${aspect}`}>Describe the picture</label>
      <textarea id={`studio-${aspect}`} rows={3} maxLength={600} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={wide ? 'e.g. soft pastel meadow with bunnies along the middle' : 'e.g. cute cartoon bunny face, pastel colors'}/>
      {!wide && <div className="studio-options"><div className="segmented" role="group" aria-label="Style">{STYLES.map((item) => <button key={item.id} type="button" aria-pressed={style === item.id} onClick={() => setStyle(item.id)}>{item.label}</button>)}</div></div>}
      <div className="studio-actions"><button type="button" className="primary-button" disabled={blocked || !description.trim() || hasKey === false} onClick={() => void generate()}><Wand2 size={15}/> {takes.length ? `Make ${TAKES} more` : `Make ${TAKES} takes`}</button></div>
    </div>
    {takes.length > 0 && <div className="takes" role="group" aria-label="Takes">{takes.map((take, index) => <button key={take.path} type="button" className={index === selected ? 'selected' : ''} aria-label={`Take ${takes.length - index}`} aria-pressed={index === selected} onClick={() => setSelected(index)}><img src={take.preview} alt=""/></button>)}</div>}
    {current && <div className="take-actions">
      <button type="button" className="primary-button" disabled={blocked} onClick={() => void use()}><Check size={15}/> Use this {wide ? 'banner' : 'picture'}</button>
      <div className="idea-row"><label htmlFor={`refine-${aspect}`} className="sr-only">Change this take</label><input id={`refine-${aspect}`} maxLength={300} value={refinement} onChange={(event) => setRefinement(event.target.value)} placeholder="Change it: e.g. warmer colors, add a bow" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (refinement.trim() && !blocked) void refine(); } }}/>
        <button type="button" className="outline-button" disabled={blocked || !refinement.trim()} onClick={() => void refine()}><Sparkles size={14}/> Refine</button></div>
    </div>}
    {working && <p className="studio-working" role="status"><Loader2 size={14} className="spin"/> {working}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
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
 * The brand's picture, made with Gemini and used on every profile of the brand by default.
 * Each social can have its own instead. Putting it on a live profile opens that social's profile
 * settings with the picture filled in at the social's size; Nate checks it and presses Save.
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
    const id = await openPlatformWindow(account.platform, 'manage');
    const sign = { email: account.signupEmail, username: normalizeHandle(account.handle) };
    await fillSiteForm(id, Object.fromEntries(Object.entries(sign).filter(([, value]) => value)), { imagePath: path, accountId: account.id, includePassword: 'ifSaved', keepFilling: true });
    setNote(`Opened ${getPlatform(account.platform).name} profile settings with the picture filled in (${PROFILE_SIZES[account.platform]} x ${PROFILE_SIZES[account.platform]}). Check the crop there, then press Save on the page.${account.platform === 'youtube' && image?.banner ? ' For the banner: on Branding press Upload under Banner image and pick the file Show banner file selects.' : ''}`);
  });
  const showBanner = () => run(async () => { if (image?.banner) await revealBrandImage(image.banner); });
  const needKey = onNavigate ? () => onNavigate('settings', 'pictures') : undefined;
  const studioFor = (what: Target) => setTarget((open) => open && open.kind === what.kind && (open.kind !== 'account' || what.kind !== 'account' || open.account.id === what.account.id) ? null : what);

  return <section className="card brand-picture" aria-labelledby="brand-picture-title">
    <div className="brand-picture-head">
      <Round file={image?.file} name={brand.name} size={84}/>
      <div className="brand-picture-text">
        <h3 id="brand-picture-title">Brand picture</h3>
        <p>{image?.file ? 'Every profile of this brand uses it unless you give one its own. It syncs to your partner\'s app.' : 'Make one picture for every profile: Instagram, TikTok, YouTube and X.'}</p>
        <div className="heading-buttons">
          <button type="button" className="primary-button small-button" disabled={blocked} aria-expanded={target?.kind === 'brand'} onClick={() => studioFor({ kind: 'brand' })}><Wand2 size={14}/> {image?.file ? 'Make a new one' : 'Generate with Gemini'}</button>
          <button type="button" className="outline-button small-button" disabled={blocked} onClick={() => void choose()}><ImagePlus size={14}/> Choose a file</button>
        </div>
      </div>
    </div>
    {target?.kind === 'brand' && <GeminiStudio key="brand" title={`Picture for ${brand.name}`} aspect="1:1" initial={image?.prompt ? '' : brand.name} busy={blocked} onUse={useSquare} onClose={() => setTarget(null)} onNeedKey={needKey}/>}

    {image?.file && <div className="banner-row">
      <div className="banner-frame" aria-label="YouTube banner preview">{bannerPreview ? <img src={bannerPreview} alt=""/> : <span>{image.banner ? 'Banner is on its way from your partner\'s app' : 'No YouTube banner yet'}</span>}<i className="safe-area" title={`Shown on every device: the centre ${BANNER.safeWidth} x ${BANNER.safeHeight}`}/></div>
      <div className="banner-text"><strong>YouTube banner</strong><small>{BANNER.width} x {BANNER.height}. The outlined middle shows on phones, TVs and computers.</small>
        <div className="heading-buttons">
          <button type="button" className="outline-button small-button" disabled={blocked} aria-expanded={target?.kind === 'banner'} onClick={() => studioFor({ kind: 'banner' })}><Wand2 size={14}/> {image.banner ? 'New banner' : 'Make a banner'}</button>
          {image.banner && <button type="button" className="ghost-button small-button" disabled={blocked} onClick={() => void showBanner()}><FolderOpen size={14}/> Show banner file</button>}
        </div></div>
    </div>}
    {target?.kind === 'banner' && <GeminiStudio key="banner" title="YouTube banner" aspect="16:9" initial={bannerPrompt(brand.name, image?.prompt ?? '')} busy={blocked} onUse={(preview) => useBanner(preview)} onClose={() => setTarget(null)} onNeedKey={needKey}/>}

    {accounts.length > 0 && <ul className="picture-socials">{accounts.map((account) => {
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
            {account.status === 'active'
              ? <button type="button" className="outline-button small-button" disabled={blocked || !file} title={file ? undefined : 'Make a brand picture first'} onClick={() => void putOn(account)}><AppWindow size={13}/> Put on {name}</button>
              : <small className="footnote">Used when it's created</small>}
            <button type="button" className="ghost-button small-button" disabled={blocked} aria-expanded={open} onClick={() => studioFor({ kind: 'account', account })}><Wand2 size={13}/> Own picture</button>
            <button type="button" className="ghost-button small-button" disabled={blocked} onClick={() => void choose(account)}><ImagePlus size={13}/><span className="sr-only">Choose a file for {name}</span></button>
            {own && <button type="button" className="ghost-button small-button" disabled={blocked} onClick={() => void run(async () => { await onSaveAccountImage(account, undefined, `${name} uses the brand picture again.`); })}><RotateCcw size={13}/> Use brand picture</button>}
          </div>
        </div>
        {open && <GeminiStudio key={account.id} title={`Own picture for ${name}`} aspect="1:1" initial={image?.prompt ? '' : brand.name} busy={blocked} onUse={useSquare} onClose={() => setTarget(null)} onNeedKey={needKey}/>}
      </li>;
    })}</ul>}
    {youtube && image?.banner && youtube.status !== 'active' && <p className="footnote">The banner goes on YouTube once the channel is created.</p>}
    {working && <p className="studio-working" role="status"><Loader2 size={14} className="spin"/> Working…</p>}
    {note && <p className="success-message" role="status">{note}</p>}
    {error && <div className="error-message" role="alert">{error}</div>}
  </section>;
}
