import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Platform, Workspace } from './model';
import { postAnalytics, postComments, replyToComment, socialAnalytics } from './ayrshareService';
import { readComments, readPostAnalytics, readSocialAnalytics, recentPosts, type Comment, type PostResult } from './results';
import { useAyrshare } from './useAyrshare';
import { draftReply } from './assistant/replyWriter';
import { errorText } from './ui';

const DAY = 86_400_000;
/** Results are read for posts of the last 30 days (Results' longest range), comments for the last 14. */
const RESULTS_DAYS = 30; const RESULTS_POSTS = 80;
const COMMENT_DAYS = 14; const COMMENT_POSTS = 30;
const EVERY = 30 * 60_000;
const STORE = 'socialspace.results.v1';

/** What Results and Comments know, kept on this PC so they show at once while fresh numbers load. */
type Saved = { posts: Record<string, PostResult>; followers: Record<string, Partial<Record<Platform, number>>>; history: Record<string, { day: number; total: number }[]>; handled: Record<string, 'answered' | 'skipped'> };
const EMPTY: Saved = { posts: {}, followers: {}, history: {}, handled: {} };
function load(): Saved {
  try { const raw = localStorage.getItem(STORE); return raw ? { ...EMPTY, ...JSON.parse(raw) as Saved } : EMPTY; } catch { return EMPTY; }
}
function keep(saved: Saved) { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch { /* storage can be off; results load again */ } }

export type Results = {
  /** Each Ayrshare post's views, likes, comments and shares. */
  posts: Record<string, PostResult>;
  /** Followers of each brand on each linked social. */
  followers: Record<string, Partial<Record<Platform, number>>>;
  /** Each brand's follower total by day, to show new followers. */
  history: Record<string, { day: number; total: number }[]>;
  comments: Comment[];
  /** Comments answered or skipped here. */
  handled: Record<string, 'answered' | 'skipped'>;
  loading: boolean;
  error: string;
  readAt: number | null;
  refresh: () => Promise<void>;
  reply: (comment: Comment, text: string) => Promise<void>;
  skip: (comment: Comment) => void;
  draft: (comment: Comment) => Promise<string | null>;
  /** Comments still to answer. */
  open: Comment[];
};

const Context = createContext<Results | null>(null);
const OFFLINE: Results = { posts: {}, followers: {}, history: {}, comments: [], handled: {}, loading: false, error: '', readAt: null, open: [],
  refresh: async () => {}, reply: async () => { throw new Error('Open the desktop app to reply.'); }, skip: () => {}, draft: async () => null };
export function useResults(): Results { return useContext(Context) ?? OFFLINE; }

/**
 * Reads results and comments from Ayrshare for every brand: followers per linked social, each recent post's
 * numbers, and the comments on recent posts. Read when the app opens and every 30 minutes after.
 */
export function ResultsProvider({ workspace, children }: { workspace: Workspace; children: ReactNode }) {
  const ayrshare = useAyrshare();
  const [saved, setSaved] = useState<Saved>(load);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [readAt, setReadAt] = useState<number | null>(null);
  const latest = useRef(workspace);
  latest.current = workspace;
  const brandsRef = useRef(ayrshare.brands);
  brandsRef.current = ayrshare.brands;
  const running = useRef(false);
  const connected = Boolean(ayrshare.status?.connected && ayrshare.status.working !== false);
  const save = useCallback((change: (current: Saved) => Saved) => setSaved((current) => { const next = change(current); keep(next); return next; }), []);

  const refresh = useCallback(async () => {
    if (!isTauri() || !connected || running.current) return;
    running.current = true; setLoading(true); setError('');
    const now = Date.now();
    const ws = latest.current;
    const problems: string[] = [];
    try {
      const posts: Record<string, PostResult> = {};
      const followers: Record<string, Partial<Record<Platform, number>>> = {};
      const found: Comment[] = [];
      for (const brand of ws.brands) {
        const linked = brandsRef.current[brand.id]?.socials;
        if (!linked?.hasProfile) continue;
        const own: Partial<Record<Platform, string>> = Object.fromEntries(linked.linked.map((item) => [item.platform, item.name]));
        const brandWs = { ...ws, videos: (ws.videos ?? []).filter((video) => video.brandId === brand.id) };
        if (linked.linked.length) {
          try { followers[brand.id] = readSocialAnalytics(await socialAnalytics(brand.id, linked.linked.map((item) => item.platform))); }
          catch (reason) { problems.push(`${brand.name}: ${errorText(reason)}`); }
        }
        for (const post of recentPosts(brandWs, now - RESULTS_DAYS * DAY, RESULTS_POSTS)) {
          try { const numbers = readPostAnalytics(await postAnalytics(brand.id, post.id))[post.platform]; if (numbers) posts[post.id] = { ...numbers, at: now }; }
          catch { /* a post just gone up may have no results yet */ }
        }
        for (const post of recentPosts(brandWs, now - COMMENT_DAYS * DAY, COMMENT_POSTS)) {
          try { found.push(...readComments(await postComments(brand.id, post.id), { brandId: brand.id, videoId: post.video.id, postId: post.id }, own).filter((item) => item.platform === post.platform)); }
          catch { /* no comments, or the social does not share them */ }
        }
      }
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      save((current) => {
        const history = { ...current.history };
        for (const [brandId, counts] of Object.entries(followers)) {
          const total = Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0);
          history[brandId] = [...(history[brandId] ?? []).filter((item) => item.day !== today.getTime() && item.day > now - 90 * DAY), { day: today.getTime(), total }];
        }
        return { ...current, posts: { ...current.posts, ...posts }, followers: { ...current.followers, ...followers }, history };
      });
      setComments(found.sort((a, b) => b.at - a.at));
      setReadAt(now);
      if (problems.length) setError(problems.join(' '));
    } finally { running.current = false; setLoading(false); }
  }, [connected, save]);

  // Once the brands' linked socials are known, then every 30 minutes.
  const ready = Object.values(ayrshare.brands).some((brand) => brand.socials?.hasProfile);
  useEffect(() => {
    if (!connected || !ready) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), EVERY);
    return () => window.clearInterval(timer);
  }, [connected, ready, refresh]);

  async function reply(comment: Comment, text: string) {
    await replyToComment(comment.brandId, comment.id, comment.platform, text, comment.socialVideoId);
    save((current) => ({ ...current, handled: { ...current.handled, [comment.id]: 'answered' } }));
  }
  const skip = (comment: Comment) => save((current) => ({ ...current, handled: { ...current.handled, [comment.id]: 'skipped' } }));
  async function draft(comment: Comment) {
    const ws = latest.current;
    return draftReply({ brand: ws.brands.find((brand) => brand.id === comment.brandId)?.name ?? '', video: ws.videos?.find((video) => video.id === comment.videoId)?.title ?? '', platform: comment.platform, author: comment.author, comment: comment.text });
  }
  const open = useMemo(() => comments.filter((comment) => !comment.answered && !saved.handled[comment.id]), [comments, saved.handled]);

  const value: Results = { ...saved, comments, loading, error, readAt, refresh, reply, skip, draft, open };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
