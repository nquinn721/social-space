import { useRef, useState } from 'react';
import { suggestVideoIdeas, VIDEO_IDEA_COUNT, type VideoIdea, type VideoIdeaRequest } from './assistant/videoIdeas';
import { errorText } from './ui';

export function useVideoIdeas(request: VideoIdeaRequest) {
  const [open, setOpen] = useState(false);
  const [ideas, setIdeas] = useState<VideoIdea[]>([]);
  const [loading, setLoading] = useState<number | 'all' | null>(null);
  const [error, setError] = useState('');
  const ideasRef = useRef<VideoIdea[]>([]);
  const active = useRef(false);
  const generation = useRef(0);

  async function get(index: number | 'all') {
    if (active.current) return;
    active.current = true;
    const version = ++generation.current;
    setLoading(index); setError('');
    try {
      const current = ideasRef.current;
      const next = await suggestVideoIdeas({ ...request, count: index === 'all' ? VIDEO_IDEA_COUNT : 1, exclude: current.map((idea) => idea.title) });
      if (generation.current !== version) return;
      const result = index === 'all' ? next : current.map((idea, position) => position === index ? next[0] : idea);
      ideasRef.current = result; setIdeas(result);
    } catch (reason) { if (generation.current === version) setError(errorText(reason, 'Could not suggest videos. Try again.')); }
    finally { if (generation.current === version) { active.current = false; setLoading(null); } }
  }
  function start() { if (active.current) return; setOpen(true); if (!ideasRef.current.length) void get('all'); }
  function close() { generation.current++; active.current = false; setLoading(null); setOpen(false); }
  function reset() { close(); ideasRef.current = []; setIdeas([]); setError(''); }
  return { open, ideas, loading, error, start, close, reset, rerollAll: () => void get('all'), reroll: (index: number) => void get(index) };
}
