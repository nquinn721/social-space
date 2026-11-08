import klingLogo from './assets/providers/kling.png';
import type { VideoProvider } from './videoSourcesService';

export type ProviderInfo = { id: VideoProvider; name: string; tagline: string; logo: string; keyHelp: string };

/** Branding and copy for each video provider. Colors live in videoSources.css under `.provider-<id>`. */
export const PROVIDERS: Record<VideoProvider, ProviderInfo> = {
  kling: { id: 'kling', name: 'Kling AI', tagline: 'Text and image to video', logo: klingLogo, keyHelp: 'Create a key in the Kling AI developer console. It is shown only once, so paste it here right away.' },
};
export const PROVIDER_LIST = Object.values(PROVIDERS);
export const MAX_SOURCE_NAME = 60;
