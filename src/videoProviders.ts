import klingLogo from './assets/providers/kling.png';
import grokLogo from './assets/providers/grok.png';
import type { VideoProvider } from './videoSourcesService';

export type ProviderInfo = {
  id: VideoProvider; name: string; tagline: string; logo: string; keyHelp: string;
  /** Model and resolution used for text-to-video, shown under the prompt. */
  model: string;
  durations: number[]; defaultDuration: number;
};

/** Branding and copy for each video provider. Colors live in videoSources.css under `.provider-<id>`. */
export const PROVIDERS: Record<VideoProvider, ProviderInfo> = {
  kling: { id: 'kling', name: 'Kling AI', tagline: 'Text and image to video', logo: klingLogo, model: 'Kling 3.0 Turbo at 720p', durations: [5, 10], defaultDuration: 5, keyHelp: 'Create a key in the Kling AI developer console. It is shown only once, so paste it here right away.' },
  grok: { id: 'grok', name: 'Grok Imagine', tagline: 'Video from xAI', logo: grokLogo, model: 'Grok Imagine video at 720p', durations: [5, 8, 10, 15], defaultDuration: 8, keyHelp: 'Create a key in the xAI console with access to the video models.' },
};
export const PROVIDER_LIST = Object.values(PROVIDERS);
export const MAX_SOURCE_NAME = 60;
export const ASPECT_RATIOS = [{ value: '16:9', label: 'Landscape (16:9)' }, { value: '9:16', label: 'Portrait (9:16)' }, { value: '1:1', label: 'Square (1:1)' }];
