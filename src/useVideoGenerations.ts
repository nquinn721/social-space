import { useCallback, useEffect, useRef, useState } from 'react';
import type { Video, VideoCategory, Workspace } from './model';
import { newPost } from './postDetails';
import { errorText } from './ui';
import { generateVideo, getVideo, saveGeneratedVideo } from './videoSourcesService';

/** How often videos being made are checked with their source while the library is open. */
export const POLL_MS = 15_000;
const FAILED = /fail|expire|error|cancel|reject/i;
const MAX_TITLE = 60;

export type MakeRequest = { category: VideoCategory; brandName: string; prompt: string; title: string; sourceId: string; aspectRatio: string; duration: number };
type Save = (next: Workspace, message: string) => Promise<boolean | undefined>;

/** A short title from the first words of a prompt. */
export function titleFromPrompt(prompt: string) {
  const words = prompt.trim().replace(/\s+/g, ' ');
  if (words.length <= MAX_TITLE) return words;
  const cut = words.slice(0, MAX_TITLE);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : MAX_TITLE)}…`;
}

/**
 * Starts AI videos inside a category and finishes them: while the library is open, each video still
 * being made is checked with its source, and once ready it is downloaded and saved into the category.
 */
export function useVideoGenerations(workspace: Workspace, onSave: Save) {
  const latest = useRef(workspace);
  latest.current = workspace;
  const inFlight = useRef(new Set<string>());
  const [progress, setProgress] = useState<Record<string, string>>({});
  const working = (workspace.videos ?? []).filter((video) => video.generation?.status === 'working');
  const workingKey = working.map((video) => video.id).join(',');

  const update = useCallback(async (id: string, change: (video: Video) => Video, message: string) => {
    const current = latest.current;
    const videos = current.videos ?? [];
    if (!videos.some((video) => video.id === id)) return true;
    return onSave({ ...current, videos: videos.map((video) => video.id === id ? change(video) : video) }, message);
  }, [onSave]);

  const check = useCallback(async (video: Video) => {
    const job = video.generation;
    if (!job || job.status !== 'working' || inFlight.current.has(video.id)) return;
    inFlight.current.add(video.id);
    try {
      const task = await getVideo(job.sourceId, job.taskId);
      if (task.videoUrl) {
        const current = latest.current;
        const brand = current.brands.find((item) => item.id === video.brandId)?.name ?? 'Brand';
        const category = current.categories?.find((item) => item.id === video.categoryId)?.name ?? 'Category';
        const path = await saveGeneratedVideo(job.sourceId, job.taskId, brand, category, video.title);
        await update(video.id, (item) => ({ ...item, mediaSource: path, prompt: job.prompt, generation: undefined }), `"${video.title}" is ready and saved to ${category}.`);
      } else if (FAILED.test(task.status)) {
        await update(video.id, (item) => ({ ...item, generation: { ...job, status: 'failed', message: task.message ?? `${job.sourceName} could not make this video.` } }), `"${video.title}" could not be made.`);
      } else {
        setProgress((now) => ({ ...now, [video.id]: task.message ?? '' }));
      }
    } catch (reason) {
      setProgress((now) => ({ ...now, [video.id]: errorText(reason, 'Could not check on this video. Trying again soon.') }));
    } finally {
      inFlight.current.delete(video.id);
    }
  }, [update]);

  useEffect(() => {
    if (!workingKey) return;
    const run = () => { for (const video of latest.current.videos ?? []) void check(video); };
    run();
    const timer = window.setInterval(run, POLL_MS);
    return () => window.clearInterval(timer);
  }, [workingKey, check]);

  /** Sends the prompt to the source and adds the video to the category right away, marked as being made. */
  async function make(request: MakeRequest) {
    const started = await generateVideo(request.sourceId, request.prompt, request.aspectRatio, request.duration);
    const title = request.title.trim() || titleFromPrompt(request.prompt);
    const video: Video = {
      id: crypto.randomUUID(), brandId: request.category.brandId, categoryId: request.category.id, title, mediaSource: '', posted: [], createdAt: Date.now(), ...newPost(request.category, true),
      generation: { sourceId: started.sourceId, sourceName: started.sourceName, provider: started.provider, taskId: started.id, prompt: request.prompt, status: 'working' },
    };
    const current = latest.current;
    return onSave({ ...current, videos: [...(current.videos ?? []), video] }, `${started.sourceName} is making "${title}". It shows up in ${request.category.name} when it's ready.`);
  }

  /** Checks a video again now, e.g. after a failed check. A failed video is retried as a new check. */
  function retry(video: Video) {
    if (!video.generation) return;
    if (video.generation.status === 'failed') void update(video.id, (item) => ({ ...item, generation: item.generation && { ...item.generation, status: 'working', message: '' } }), `Checking "${video.title}" again.`);
    else void check(video);
  }

  return { make, retry, progress };
}
