import { useEffect, useState } from 'react';

/** The time, moved on every minute, so a new day frees the daily limits and "today" changes without a reload. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  return now;
}
