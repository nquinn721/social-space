import { useEffect, useRef, useState } from 'react';
import { suggestBrandIdeas } from './assistant/brandIdeas';
import { errorText } from './ui';

/** Keeps idea generation separate from filling the account form. */
export function useBrandIdeas(context: string) {
  const [open, setOpen] = useState(false);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [loadingIndex, setLoadingIndex] = useState<number | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => () => { sequence.current += 1; }, []);

  async function generate(index: number | null, previous: string[]) {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++sequence.current;
    setLoadingAll(index === null);
    setLoadingIndex(index);
    setError('');
    try {
      const result = await suggestBrandIdeas({ context: context.trim(), exclude: previous, count: index === null ? 5 : 1 });
      if (request !== sequence.current) return;
      setIdeas(index === null ? result : previous.map((idea, position) => position === index ? result[0] : idea));
    } catch (reason) {
      if (request === sequence.current) setError(errorText(reason, 'Could not get ideas. Try again.'));
    } finally {
      if (request === sequence.current) { inFlight.current = false; setLoadingAll(false); setLoadingIndex(null); }
    }
  }

  function show() {
    if (open || inFlight.current) return;
    setOpen(true);
    setIdeas([]);
    void generate(null, []);
  }
  function close() {
    sequence.current += 1;
    inFlight.current = false;
    setLoadingAll(false);
    setLoadingIndex(null);
    setError('');
    setOpen(false);
  }
  return { open, ideas, loadingAll, loadingIndex, error, show, close,
    rerollAll: () => void generate(null, ideas), reroll: (index: number) => void generate(index, ideas) };
}
