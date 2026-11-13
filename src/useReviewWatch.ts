import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { emailConnection, listEmails, type EmailSummary } from './emailService';
import { APP_REVIEWS, reviewChangesFrom, reviewStatus, stateLabel, type AppReview, type ReviewState } from './appReviews';
import type { Workspace } from './model';

/** How often the inbox is read for review results while a review is still open. */
export const REVIEW_CHECK_MS = 15 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;

type Options = {
  loaded: boolean;
  workspaceRef: MutableRefObject<Workspace>;
  /** Saves the workspace (merged with any sync that ran meanwhile). */
  save: (next: Workspace) => Promise<unknown>;
  /** Tells the user what changed. */
  notify: (text: string) => void;
};
export type ReviewWatch = { checking: boolean; lastChecked: number | null; note: string; checkNow: () => Promise<void> };

/** Reads the result emails of the developer-app reviews that are not approved yet, and records what they say. */
export function useReviewWatch({ loaded, workspaceRef, save, notify }: Options): ReviewWatch {
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const running = useRef(false);
  const latest = useRef({ save, notify });
  latest.current = { save, notify };

  const check = useCallback(async (manual: boolean) => {
    if (running.current || !isTauri()) return;
    const open = APP_REVIEWS.filter((review) => reviewStatus(workspaceRef.current.setup, review.provider).state !== 'approved');
    if (!open.length) { if (manual) setNote('Every review is approved.'); return; }
    running.current = true; setChecking(true);
    try {
      if (!await emailConnection()) { setNote('Connect the email inbox (Settings, Email inbox) so the app can see review results.'); return; }
      const mails: EmailSummary[] = [];
      for (const review of open) mails.push(...await listEmails({ limit: 25, search: review.search }));
      setLastChecked(Date.now());
      // Worked out against the workspace as it is now, in case a sync or an edit landed while reading.
      const current = workspaceRef.current;
      const result = reviewChangesFrom(current.setup, mails);
      if (!result) { setNote(manual ? 'No new review emails.' : ''); return; }
      await latest.current.save({ ...current, setup: result.marks });
      const text = reviewNews(result.changed);
      setNote(text);
      latest.current.notify(text);
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : String(reason));
    } finally { running.current = false; setChecking(false); }
  }, [workspaceRef]);

  useEffect(() => {
    if (!loaded || !isTauri()) return;
    const first = window.setTimeout(() => void check(false), FIRST_CHECK_MS);
    const every = window.setInterval(() => void check(false), REVIEW_CHECK_MS);
    return () => { window.clearTimeout(first); window.clearInterval(every); };
  }, [loaded, check]);

  return { checking, lastChecked, note, checkNow: () => check(true) };
}

/** "TikTok app review: Approved." for each review that changed. */
export function reviewNews(changed: { review: AppReview; state: ReviewState }[]) {
  return changed.map(({ review, state }) => `${review.name}: ${stateLabel(state)}${state === 'approved' ? '!' : '.'}`).join(' ');
}
