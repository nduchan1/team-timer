// Page-lifecycle plumbing: keep-alive measures, and detection of the ways a background tab can be
// stopped (discarded, frozen), so the app can warn instead of silently missing raids.

export type LifeEvent =
  | { type: 'visible' }
  | { type: 'hidden' }
  | { type: 'resume'; frozenMs: number }
  | { type: 'online' };

/** Chrome/Edge set this when the tab was reloaded after being discarded in the background. */
export const wasDiscarded = document.wasDiscarded === true;

let lockHeld = false;
let installed = false;
let frozenAt: number | null = null;
const listeners = new Set<(e: LifeEvent) => void>();

/**
 * Holds a Web Lock for the page's lifetime. Chrome does not freeze a tab whose document holds a lock
 * (Energy Saver, and memory-pressure freezing on Windows). It must be taken by the document, not a
 * worker, and granted, not queued, hence the unique name.
 */
export function holdWebLock(): void {
  if (lockHeld || !navigator.locks) return;
  const name = `tt-alive-${crypto.randomUUID()}`;
  navigator.locks
    .request(name, () => {
      lockHeld = true;
      return new Promise<void>(() => {});
    })
    .catch(() => {});
}

export function isLockHeld(): boolean {
  return lockHeld;
}

function emit(e: LifeEvent): void {
  for (const cb of listeners) cb(e);
}

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('visibilitychange', () => emit({ type: document.hidden ? 'hidden' : 'visible' }));
  document.addEventListener('freeze', () => {
    frozenAt = performance.now();
  });
  document.addEventListener('resume', () => {
    const frozenMs = frozenAt === null ? 0 : performance.now() - frozenAt;
    frozenAt = null;
    emit({ type: 'resume', frozenMs });
  });
  window.addEventListener('online', () => emit({ type: 'online' }));
}

export function onLife(cb: (e: LifeEvent) => void): () => void {
  install();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Notifications are only a fallback (sound off, or raids missed) or rare (a reminder came due). Chrome
// revokes notification permission from sites that send many notifications nobody clicks, so never send
// one per loop. Each kind has its own tag and budget, so a reminder never hides a missed-raid alert.
const NOTIFY_GAP_MS = 180_000;
export type NotifyKind = 'raid' | 'reminder';
const lastNotify: Record<NotifyKind, number> = { raid: -Infinity, reminder: -Infinity };

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** `id` (e.g. one reminder's due moment) gives it its own tag, so it is a new alert, not a silent update. */
export function notify(title: string, body: string, kind: NotifyKind = 'raid', id = ''): boolean {
  if (notificationPermission() !== 'granted') return false;
  const now = performance.now();
  if (now - lastNotify[kind] < NOTIFY_GAP_MS) return false;
  try {
    const n = new Notification(title, { body, tag: id ? `tt-${kind}-${id}` : `tt-${kind}` });
    lastNotify[kind] = now; // a notification that could not be shown doesn't use up the budget
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
