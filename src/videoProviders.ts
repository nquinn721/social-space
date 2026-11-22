import klingLogo from './assets/providers/kling.png';
import grokLogo from './assets/providers/grok.png';
import type { VideoProvider } from './videoSourcesService';

export type ProviderInfo = {
  id: VideoProvider; name: string; tagline: string; logo: string; keyHelp: string;
  /** Model and resolution used for text-to-video, shown under the prompt. */
  model: string;
  durations: number[]; defaultDuration: number;
  /** Takes character pictures with a clip, so a series' characters look the same in every part. */
  references: boolean;
};

/** Branding and copy for each video provider. Colors live in videoSources.css under `.provider-<id>`. */
export const PROVIDERS: Record<VideoProvider, ProviderInfo> = {
  kling: { id: 'kling', name: 'Kling AI', tagline: 'Text and image to video', logo: klingLogo, model: 'Kling 3.0 Turbo at 720p', durations: [5, 10], defaultDuration: 10, references: false, keyHelp: 'Create a key in the Kling AI developer console. It is shown only once, so paste it here right away.' },
  grok: { id: 'grok', name: 'Grok Imagine', tagline: 'Video from xAI', logo: grokLogo, model: 'Grok Imagine Video 1.5 at 1080p', durations: Array.from({ length: 15 }, (_, index) => index + 1), defaultDuration: 15, references: true, keyHelp: 'Create a key in the xAI console with access to the video models.' },
};
export const PROVIDER_LIST = Object.values(PROVIDERS);
export const MAX_SOURCE_NAME = 60;
export const ASPECT_RATIOS = [{ value: '16:9', label: 'Landscape (16:9)' }, { value: '9:16', label: 'Portrait (9:16)' }, { value: '1:1', label: 'Square (1:1)' }];
