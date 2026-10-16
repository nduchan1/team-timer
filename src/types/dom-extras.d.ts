// DOM APIs used by the app that TypeScript 6's lib.dom does not declare yet.

interface Document {
  /** Chrome/Edge: true when this page was reloaded after the browser discarded the tab. */
  readonly wasDiscarded?: boolean;
}

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}

interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
}

interface Window {
  /** Chrome/Edge 116+, Firefox 151+. */
  readonly documentPictureInPicture?: DocumentPictureInPicture;
}

/** Safari 16.4+ (Audio Session API): how the page's audio mixes with other apps and the silent switch. */
interface AudioSession extends EventTarget {
  type: 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
}

interface Navigator {
  readonly audioSession?: AudioSession;
}
