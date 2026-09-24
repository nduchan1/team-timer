// Document Picture-in-Picture pop-out: a small always-on-top window over the game. While it is open,
// Chrome treats the timer tab as visible (no throttling, no discarding). It needs a click to open, and it
// closes when the timer tab reloads or when any other tab opens a picture-in-picture window.

export const pipSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window;

let win: Window | null = null;
let closedByApp = false;
const listeners = new Set<(closedUnexpectedly: boolean) => void>();

function emit(closedUnexpectedly: boolean): void {
  for (const cb of listeners) cb(closedUnexpectedly);
}

export function pipWindow(): Window | null {
  return win;
}

export function subscribePip(cb: (closedUnexpectedly: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function copyStyles(target: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      target.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
}

/** Opens the pop-out. Must be called from a click. */
export async function openPip(): Promise<Window | null> {
  const api = window.documentPictureInPicture;
  if (!api) return null;
  if (win) return win;
  const w = await api.requestWindow({ width: 300, height: 190 });
  copyStyles(w.document);
  w.document.title = 'Team Timer';
  w.document.body.className = 'pip-body';
  closedByApp = false;
  w.addEventListener('pagehide', () => {
    if (win !== w) return;
    win = null;
    emit(!closedByApp);
  });
  win = w;
  emit(false);
  return w;
}

export function closePip(): void {
  if (!win) return;
  closedByApp = true;
  win.close();
}
