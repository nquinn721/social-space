import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Brand, Platform, Video, Workspace } from './model';
import {
  adoptBrandProfile, ayrshareStatus, brandSocials, createBrandProfile, deletePost, disconnectAyrshare, forgetBrandProfile, openLinking,
  postHistory, removeXKeys, saveAyrshareKey, saveXKeys, sendPost, uploadVideo, type AyrshareStatus, type BrandSocials,
} from './ayrshareService';
import { applyHistory, hasOpenPosts, mediaUsable, postBody, readPostResponse, withoutPost, withPost, type SendResult } from './ayrsharePosting';
import { brandStatuses, type StatusInputs } from './brandStatus';
import { planSchedule, postingSettings } from './postQueue';
import { isLocalVideo } from './videoFileService';
import { brandLogin } from './brandWindowService';
import { errorText } from './ui';

/** Changes the latest workspace and saves it; returns what was saved. */
export type Update = (change: (current: Workspace) => Workspace) => Promise<Workspace>;
type BrandState = { socials?: BrandSocials | null; error?: string };
/** What the automatic scheduler is doing. */
export type AutoState = { running: boolean; current?: string; paused?: string };

export type Ayrshare = {
  /** null while checking. */
  status: AyrshareStatus | null;
  brands: Record<string, BrandState>;
  /** What brandStatus needs for a brand. */
  inputs: (brandId?: string) => StatusInputs;
  refresh: () => Promise<void>;
  refreshBrand: (brandId: string) => Promise<void>;
  saveKey: (key: string) => Promise<void>;
  disconnect: () => Promise<void>;
  saveXKeys: (key: string, secret: string) => Promise<void>;
  removeXKeys: () => Promise<void>;
  createProfile: (brand: Brand) => Promise<void>;
  adoptProfile: (brand: Brand, profileKey: string) => Promise<void>;
  forgetProfile: (brand: Brand) => Promise<void>;
  /** Opens Ayrshare's linking page in the brand's window, then watches for the new links. */
  link: (brand: Brand) => Promise<void>;
  /** Posts one video to one social now, or schedules it at `at`. */
  send: (videoId: string, platform: Platform, at?: number) => Promise<SendResult>;
  /** Cancels a scheduled post; the video goes back to waiting. */
  cancel: (videoId: string, platform: Platform) => Promise<void>;
  /** Puts a failed post back in the queue. */
  retry: (videoId: string, platform: Platform) => Promise<void>;
  /** Reads the brand's posts back from Ayrshare. */
  sync: (brandId: string) => Promise<void>;
  isSending: (videoId: string, platform: Platform) => boolean;
  auto: AutoState;
};

const NO_INPUTS: StatusInputs = {};
const Context = createContext<Ayrshare | null>(null);

/** Outside the provider (tests, previews): nothing connected, every action refused. */
const refuse = async () => { throw new Error('Open the desktop app to post through Ayrshare.'); };
const OFFLINE: Ayrshare = {
  status: { connected: false, working: null, xKeys: false, account: null, detail: null }, brands: {}, inputs: () => ({ ayrshare: { connected: false, xKeys: false } }),
  refresh: async () => {}, refreshBrand: async () => {}, saveKey: refuse, disconnect: refuse, saveXKeys: refuse, removeXKeys: refuse, createProfile: refuse, adoptProfile: refuse,
  forgetProfile: refuse, link: refuse, send: refuse, cancel: refuse, retry: refuse, sync: async () => {}, isSending: () => false, auto: { running: false },
};
export function useAyrshare(): Ayrshare { return useContext(Context) ?? OFFLINE; }

const mapVideo = (workspace: Workspace, id: string, change: (video: Video) => Video): Workspace =>
  ({ ...workspace, videos: (workspace.videos ?? []).map((video) => video.id === id ? change(video) : video) });
const HISTORY_EVERY = 5 * 60_000;
const FOCUS_REFRESH_GAP = 30_000;
const LINK_WATCH = { every: 8_000, for: 4 * 60_000 };
const AUTO_RETRY_AFTER = 10 * 60_000;

type Props = { workspace: Workspace; loaded: boolean; update: Update; notify: (message: string) => void; children: ReactNode };

/**
 * Holds everything the app knows from Ayrshare (the account, and which socials each brand has linked) and
 * does all posting. While the app is open and the queue is on auto, it schedules every waiting video into
 * the next free slot of each social (at most 3 a day per account), one at a time, and reads the results back.
 */
export function AyrshareProvider({ workspace, loaded, update, notify, children }: Props) {
  const [status, setStatus] = useState<AyrshareStatus | null>(null);
  const [brands, setBrands] = useState<Record<string, BrandState>>({});
  const [sending, setSending] = useState<string[]>([]);
  const [auto, setAuto] = useState<AutoState>({ running: false });
  const latest = useRef(workspace);
  latest.current = workspace;
  const inFlight = useRef(new Set<string>());
  const desktop = isTauri();
  const working = Boolean(status?.connected && status.working !== false);

  const refreshBrand = useCallback(async (brandId: string) => {
    try { const socials = await brandSocials(brandId); setBrands((current) => ({ ...current, [brandId]: { socials } })); }
    catch (reason) { setBrands((current) => ({ ...current, [brandId]: { socials: null, error: errorText(reason) } })); }
  }, []);
  const refreshAll = useCallback(async (state: AyrshareStatus | null) => {
    if (!state?.connected || state.working === false) return;
    await Promise.all(latest.current.brands.map((brand) => refreshBrand(brand.id)));
  }, [refreshBrand]);
  const refresh = useCallback(async () => {
    if (!desktop) { setStatus(OFFLINE.status); return; }
    let next: AyrshareStatus;
    try { next = await ayrshareStatus(); } catch (reason) { next = { connected: false, working: null, xKeys: false, account: null, detail: errorText(reason) }; }
    setStatus(next);
    await refreshAll(next);
  }, [desktop, refreshAll]);

  useEffect(() => { if (loaded) void refresh(); }, [loaded, refresh]);
  // A brand added later is checked once Ayrshare is known.
  const brandIds = workspace.brands.map((brand) => brand.id).join('|');
  useEffect(() => {
    if (!working) return;
    for (const brand of latest.current.brands) if (!(brand.id in brands)) void refreshBrand(brand.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandIds, working]);
  // Coming back to the app (after linking a social in its window, say) checks the links again.
  const lastFocus = useRef(0);
  useEffect(() => {
    const onFocus = () => { if (Date.now() - lastFocus.current < FOCUS_REFRESH_GAP) return; lastFocus.current = Date.now(); void refreshAll(status); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshAll, status]);

  const inputsByBrand = useMemo(() => {
    const ayrshare = status ? { connected: working, xKeys: status.xKeys } : undefined;
    const map: Record<string, StatusInputs> = {};
    for (const brand of workspace.brands) map[brand.id] = { ayrshare, socials: brands[brand.id]?.socials };
    return { map, fallback: ayrshare ? { ayrshare } : NO_INPUTS };
  }, [status, working, brands, workspace.brands]);
  const inputs = useCallback((brandId?: string) => (brandId && inputsByBrand.map[brandId]) || inputsByBrand.fallback, [inputsByBrand]);

  // ---------- account and profiles ----------
  async function saveKey(key: string) { const next = await saveAyrshareKey(key); setStatus(next); await refreshAll(next); }
  async function disconnect() { await disconnectAyrshare(); setBrands({}); await refresh(); }
  async function saveX(key: string, secret: string) { await saveXKeys(key, secret); await refresh(); }
  async function removeX() { await removeXKeys(); await refresh(); }
  const recordProfile = (brand: Brand, refId: string, title: string) =>
    update((current) => ({ ...current, brands: current.brands.map((item) => item.id === brand.id ? { ...item, ayrshare: { refId, title: title || brand.name } } : item) }));
  async function createProfile(brand: Brand) { const made = await createBrandProfile(brand.id, brand.name); await recordProfile(brand, made.refId, made.title); await refreshBrand(brand.id); }
  async function adoptProfile(brand: Brand, key: string) { const made = await adoptBrandProfile(brand.id, key); await recordProfile(brand, made.refId, made.title); await refreshBrand(brand.id); }
  async function forgetProfile(brand: Brand) {
    await forgetBrandProfile(brand.id);
    await update((current) => ({ ...current, brands: current.brands.map((item) => { if (item.id !== brand.id) return item; const { ayrshare: _, ...rest } = item; return rest; }) }));
    await refreshBrand(brand.id);
  }
  const watching = useRef<Record<string, number>>({});
  async function link(brand: Brand) {
    const logins = latest.current.accounts.filter((account) => account.brandId === brand.id && account.status === 'active').flatMap((account) => {
      const login = brandLogin(account);
      return login.accountId ? [{ platform: account.platform, accountId: login.accountId, handle: account.handle, email: login.email }] : [];
    });
    await openLinking(brand.id, brand.name, logins);
    // Watch for the new links while the window is likely open.
    window.clearInterval(watching.current[brand.id]);
    const started = Date.now();
    watching.current[brand.id] = window.setInterval(() => {
      if (Date.now() - started > LINK_WATCH.for) { window.clearInterval(watching.current[brand.id]); return; }
      void refreshBrand(brand.id);
    }, LINK_WATCH.every);
  }
  useEffect(() => () => { for (const timer of Object.values(watching.current)) window.clearInterval(timer); }, []);

  // ---------- posting ----------
  const key = (videoId: string, platform: Platform) => `${videoId}:${platform}`;
  const find = (videoId: string) => latest.current.videos?.find((video) => video.id === videoId);
  async function send(videoId: string, platform: Platform, at?: number): Promise<SendResult> {
    const id = key(videoId, platform);
    if (inFlight.current.has(id)) throw new Error('This post is already on its way.');
    const video = find(videoId);
    if (!video) throw new Error('That video is gone.');
    if (video.posted.includes(platform) || video.scheduled?.[platform]?.state === 'scheduled') throw new Error('It is already posted or scheduled there.');
    if (!isLocalVideo(video.mediaSource)) throw new Error('This video has no file on this PC yet.');
    inFlight.current.add(id); setSending((list) => [...list, id]);
    try {
      const when = at ?? Date.now();
      let media = video.media;
      if (!mediaUsable(media, video.mediaSource, when)) {
        const uploaded = await uploadVideo(video.mediaSource);
        media = { url: uploaded.url, at: Date.now(), keepDays: uploaded.keepDays, source: video.mediaSource };
        const saved = media;
        await update((current) => mapVideo(current, videoId, (item) => ({ ...item, media: saved })));
      }
      const fresh = find(videoId) ?? video;
      const response = await sendPost(video.brandId, postBody(fresh, platform, media!.url, at));
      const result = readPostResponse(response, platform, when);
      await update((current) => mapVideo(current, videoId, (item) => withPost(item, platform, result)));
      return result;
    } finally {
      inFlight.current.delete(id); setSending((list) => list.filter((item) => item !== id));
    }
  }
  async function cancel(videoId: string, platform: Platform) {
    const video = find(videoId);
    const post = video?.scheduled?.[platform];
    if (!video || !post) return;
    if (post.id && post.state === 'scheduled') await deletePost(video.brandId, post.id);
    await update((current) => mapVideo(current, videoId, (item) => withoutPost(item, platform)));
  }
  async function retry(videoId: string, platform: Platform) {
    await update((current) => mapVideo(current, videoId, (item) => item.scheduled?.[platform]?.state === 'failed' ? withoutPost(item, platform) : item));
  }
  const sync = useCallback(async (brandId: string) => {
    const history = await postHistory(brandId);
    const changed = applyHistory(latest.current, brandId, history);
    if (changed) await update((current) => applyHistory(current, brandId, history) ?? current);
  }, [update]);

  // Reads the results back now and then while posts are scheduled.
  useEffect(() => {
    if (!working) return;
    const run = () => { for (const brand of latest.current.brands) if (brands[brand.id]?.socials?.hasProfile && hasOpenPosts(latest.current, brand.id)) void sync(brand.id).catch(() => undefined); };
    run();
    const timer = window.setInterval(run, HISTORY_EVERY);
    return () => window.clearInterval(timer);
  }, [working, brands, sync]);

  // ---------- automatic scheduling ----------
  const [tick, setTick] = useState(0);
  const autoBusy = useRef(false);
  const pausedUntil = useRef(0);
  const failures = useRef(0);
  const scheduledCount = useRef(0);
  const settings = postingSettings(workspace);
  useEffect(() => {
    if (!loaded || !working || !settings.autoSchedule || autoBusy.current || Date.now() < pausedUntil.current) return;
    const current = latest.current;
    const next = current.brands.flatMap((brand) => {
      if (!brands[brand.id]?.socials?.hasProfile) return [];
      const platforms = brandStatuses(current, brand.id, inputsByBrand.map[brand.id]).filter((item) => item.canPost).map((item) => item.platform);
      return planSchedule(current, brand.id, platforms).slice(0, 1);
    }).sort((a, b) => a.at - b.at)[0];
    if (!next) {
      if (scheduledCount.current) { notify(`Scheduled ${scheduledCount.current} ${scheduledCount.current === 1 ? 'post' : 'posts'} through Ayrshare.`); scheduledCount.current = 0; }
      setAuto((state) => state.running || state.current ? { running: false, paused: state.paused } : state);
      return;
    }
    const video = current.videos?.find((item) => item.id === next.videoId);
    autoBusy.current = true;
    setAuto({ running: true, current: video?.title });
    send(next.videoId, next.platform, next.at)
      .then((result) => {
        if (result.post.state === 'failed') failures.current += 1; else { failures.current = 0; scheduledCount.current += 1; }
        if (failures.current >= 3) { pausedUntil.current = Date.now() + AUTO_RETRY_AFTER; setAuto({ running: false, paused: `Ayrshare refused the last 3 posts (${result.post.error ?? 'no reason given'}). Scheduling tries again in 10 minutes.` }); failures.current = 0; }
      })
      .catch((reason) => { pausedUntil.current = Date.now() + AUTO_RETRY_AFTER; setAuto({ running: false, paused: `${errorText(reason, 'Could not schedule a post.')} Scheduling tries again in 10 minutes.` }); })
      .finally(() => { autoBusy.current = false; setTick((value) => value + 1); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, working, settings.autoSchedule, brands, workspace, tick]);
  // Wakes the scheduler after a pause, and once in a while so new days open new slots.
  useEffect(() => { const timer = window.setInterval(() => setTick((value) => value + 1), AUTO_RETRY_AFTER); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!settings.autoSchedule) setAuto({ running: false }); }, [settings.autoSchedule]);

  const value: Ayrshare = {
    status, brands, inputs, refresh, refreshBrand, saveKey, disconnect, saveXKeys: saveX, removeXKeys: removeX, createProfile, adoptProfile, forgetProfile, link,
    send, cancel, retry, sync, isSending: (videoId, platform) => sending.includes(key(videoId, platform)), auto,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
