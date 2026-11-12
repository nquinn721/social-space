import { useEffect, useState, type ReactNode } from 'react';
import { getPlatform, type Account, type Platform } from './model';
import { loadImagePreview } from './profileService';
import { SOCIAL_ICON_PATHS } from './socialIcons';

/** Platform logo tile. Decorative by default, since its name is almost always printed next to it. */
export function BrandMark({ platform, small = false, label = false }: { platform: Platform; small?: boolean; label?: boolean }) {
  const item = getPlatform(platform);
  return <span className={`platform-mark ${small ? 'small' : ''} ${platform}`} {...(label ? { role: 'img', 'aria-label': item.name } : { 'aria-hidden': true })}>
    <svg viewBox="0 0 24 24" focusable="false"><path d={SOCIAL_ICON_PATHS[platform]}/></svg>
  </span>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <p className="greeting">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-buttons">{actions}</div>}</div>;
}

export const initialOf = (text: string, fallback = 'S') => text.trim().charAt(0).toUpperCase() || fallback;

/** Profile picture when the account has one, otherwise its initial. */
export function AccountAvatar({ account, name, size = '', round = false }: { account?: Pick<Account, 'imagePath'>; name: string; size?: '' | 'lg'; round?: boolean }) {
  const preview = useImagePreview(account?.imagePath ?? '');
  return <span className={`avatar ${size} ${round ? 'round' : ''}`} aria-hidden="true">{preview ? <img src={preview} alt=""/> : initialOf(name)}</span>;
}

export function useImagePreview(path: string) {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    let live = true;
    setPreview('');
    if (path) loadImagePreview(path).then((value) => { if (live) setPreview(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [path]);
  return preview;
}

export function errorText(reason: unknown, fallback = 'Something went wrong.') {
  return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : fallback;
}
