import { useEffect, useState, type FormEvent } from 'react';
import { AppWindow, ImagePlus, Sparkles, UserRound, X as Close } from 'lucide-react';
import AccountCredentials from './AccountCredentials';
import { BIO_LIMITS, createAccount, getPlatform, PLATFORMS, type Account, type Platform } from './model';
import { chooseImageFile, fillSiteForm, formFieldsFor, openPlatformWindow } from './profileService';
import { BrandMark, errorText, useImagePreview } from './ui';

type Props = { account: Account | null; busy: boolean; onClose: () => void; onSave: (account: Account) => Promise<void>; onRemove: (account: Account) => Promise<void> };

/** Side panel to add an account or see and edit one, with its sign-in details on top. */
export default function AccountDrawer({ account, busy, onClose, onSave, onRemove }: Props) {
  const [platform, setPlatform] = useState<Platform>(account?.platform ?? 'instagram');
  const [label, setLabel] = useState(account?.label ?? '');
  const [handle, setHandle] = useState(account?.handle ?? '');
  const [status, setStatus] = useState<Account['status']>(account?.status ?? 'planned');
  const [notes, setNotes] = useState(account?.notes ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [bio, setBio] = useState(account?.bio ?? '');
  const [website, setWebsite] = useState(account?.website ?? '');
  const [signupEmail, setSignupEmail] = useState(account?.signupEmail ?? '');
  const [imagePath, setImagePath] = useState(account?.imagePath ?? '');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const preview = useImagePreview(imagePath);
  const bioLimit = BIO_LIMITS[platform];
  const disabled = busy || working;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !disabled) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, onClose]);

  async function run(action: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError(''); setNote('');
    try { await action(); } catch (reason) { setError(errorText(reason)); } finally { setWorking(false); }
  }
  const pickImage = () => run(async () => { const path = await chooseImageFile(); if (path) setImagePath(path); });
  const openManage = () => run(async () => { if (account) { await openPlatformWindow(account.platform, 'manage'); setNote(`Opened ${getPlatform(account.platform).name}.`); } });
  const fillProfile = () => run(async () => {
    if (!account) return;
    const current = { ...account, displayName, bio, website, imagePath };
    const id = await openPlatformWindow(account.platform, 'manage');
    await fillSiteForm(id, formFieldsFor(current), { imagePath: imagePath || undefined, accountId: account.id, keepFilling: true });
    setNote(`Opened ${getPlatform(account.platform).name} profile settings and filled what matched. Check it, then save on the page.`);
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || !label.trim() || bio.trim().length > bioLimit) return;
    const next = { ...account, ...createAccount(platform, label, handle, status, notes), displayName: displayName.trim(), bio: bio.trim(), website: website.trim(), signupEmail: signupEmail.trim(), imagePath };
    void onSave(account ? { ...next, id: account.id } : next);
  }
  const title = account ? 'Edit account' : 'Add an account';

  return <>
    <div className="drawer-backdrop" onMouseDown={() => { if (!disabled) onClose(); }}/>
    <section className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header className="drawer-head">
        {account ? <BrandMark platform={account.platform}/> : <span className="platform-mark x"><UserRound size={18}/></span>}
        <div><h2 id="drawer-title">{title}</h2><p>{account ? `${account.label} on ${getPlatform(account.platform).name}` : "Save an account you already have. This won't sign in or create anything."}</p></div>
        {account && <span className={`pill ${account.status}`}><span className="dot"/>{account.status === 'active' ? 'Live' : 'Planned'}</span>}
        <button className="icon-button" onClick={onClose} aria-label="Close" disabled={disabled}><Close size={18}/></button>
      </header>
      <div className="drawer-body">
        {account && <div className="drawer-section">
          <AccountCredentials account={account}/>
          <div className="drawer-actions">
            <button type="button" className="outline-button small-button" disabled={disabled} onClick={() => void openManage()}><AppWindow size={14}/> Open {getPlatform(account.platform).name}</button>
            <button type="button" className="outline-button small-button" disabled={disabled} onClick={() => void fillProfile()}><Sparkles size={14}/> Fill profile on {getPlatform(account.platform).name}</button>
          </div>
          {note && <p className="success-message" role="status">{note}</p>}
        </div>}
        <form id="account-form" onSubmit={submit}>
          <div className="drawer-section">
            <h3>Account</h3>
            <div className="field-row">
              <div><label htmlFor="platform">Platform</label><select id="platform" value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>{PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
              <div><label htmlFor="status">Status</label><select id="status" value={status} onChange={(event) => setStatus(event.target.value as Account['status'])}><option value="planned">Planned</option><option value="active">In use</option></select></div>
            </div>
            <label htmlFor="label">Account name</label><input id="label" autoFocus={!account} value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Soft Wings Studio" required/>
            <label htmlFor="handle">Handle <span>optional</span></label><input id="handle" value={handle} maxLength={120} onChange={(event) => setHandle(event.target.value)} placeholder="@yourbusiness"/>
            <label htmlFor="signup-email">Sign-up email <span>optional</span></label><input id="signup-email" type="email" value={signupEmail} maxLength={320} onChange={(event) => setSignupEmail(event.target.value)}/>
          </div>
          <div className="drawer-section">
            <h3>Profile</h3>
            <label>Profile image <span>optional</span></label>
            <div className="profile-image">{preview ? <img src={preview} alt="Profile preview"/> : <span className="image-placeholder"><ImagePlus size={18}/></span>}<span>{imagePath ? imagePath.split(/[\\/]/).pop() : 'No image chosen'}</span>{imagePath && <button type="button" className="ghost-button small-button" onClick={() => setImagePath('')}>Clear</button>}<button type="button" className="outline-button small-button" disabled={disabled} onClick={() => void pickImage()}>Choose</button></div>
            <label htmlFor="display-name">Display name <span>optional</span></label><input id="display-name" value={displayName} maxLength={120} onChange={(event) => setDisplayName(event.target.value)}/>
            <label htmlFor="bio">Profile description <span className={`bio-count ${bio.trim().length > bioLimit ? 'over' : ''}`}>{bio.trim().length}/{bioLimit}</span></label><textarea id="bio" value={bio} maxLength={1000} rows={3} onChange={(event) => setBio(event.target.value)}/>
            <label htmlFor="website">Website <span>optional</span></label><input id="website" value={website} maxLength={300} onChange={(event) => setWebsite(event.target.value)}/>
          </div>
          <div className="drawer-section">
            <h3>Notes</h3>
            <label htmlFor="notes" className="sr-only">Notes <span>optional</span></label><textarea id="notes" value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} placeholder="Anything to remember (passwords go in Sign-in details above)" rows={3}/>
          </div>
        </form>
        {error && <div className="error-message" role="alert">{error}</div>}
      </div>
      <footer className="drawer-foot">
        {account && <button type="button" className="remove-button" disabled={disabled} onClick={() => void onRemove(account)}>Remove</button>}
        <button type="button" className="outline-button" disabled={disabled} onClick={onClose}>Cancel</button>
        <button form="account-form" className="primary-button" disabled={disabled || !label.trim() || bio.trim().length > bioLimit}>{account ? 'Save changes' : 'Add account'}</button>
      </footer>
    </section>
  </>;
}
