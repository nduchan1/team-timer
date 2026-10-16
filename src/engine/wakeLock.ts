// Screen Wake Lock while the player is on duty: the screen stays on (on most desktops this also keeps
// the PC from idle sleep) as long as the timer page is visible: its own window, a second screen, a
// phone in split-screen. Browsers drop the lock whenever the page is hidden, so it is taken again when
// the page shows or the player clicks (iPhones only grant the first request from a click).

import { pipWindow, subscribePip } from './pip.ts';

export const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

/** Controllers that want the lock; a room switch briefly has two. */
const wanted = new Set<string>();
/** One lock per document: the timer page, and the pop-out's own document. */
interface Slot {
  lock: WakeLockSentinel | null;
  pending: boolean;
}
const main: Slot = { lock: null, pending: false };
const pip: Slot = { lock: null, pending: false };
let installed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

function live(slot: Slot): boolean {
  return slot.lock !== null && !slot.lock.released;
}

function request(nav: Navigator, slot: Slot): void {
  if (live(slot) || slot.pending) return;
  slot.pending = true;
  nav.wakeLock
    .request('screen')
    .then((lock) => {
      if (wanted.size === 0) {
        void lock.release().catch(() => {});
        return;
      }
      slot.lock = lock;
      lock.addEventListener('release', emit);
      emit();
    })
    .catch(() => {
      // hidden page, no click yet, or battery saver: tried again on the next show or click
    })
    .finally(() => {
      slot.pending = false;
    });
}

const watchedPip = new WeakSet<Window>();

/** The pop-out shows and hides on its own (screen lock, another desktop) while the timer tab stays hidden. */
function watchPip(w: Window): void {
  if (watchedPip.has(w)) return;
  watchedPip.add(w);
  w.document.addEventListener('visibilitychange', acquire);
  w.document.addEventListener('pointerdown', acquire, true);
}

function acquire(): void {
  if (wanted.size === 0) return;
  if (document.visibilityState === 'visible') request(navigator, main);
  // Untested territory: the pop-out has its own document, visible while the timer tab is hidden.
  const w = pipWindow();
  if (!w) return;
  watchPip(w);
  if ('wakeLock' in w.navigator && w.document.visibilityState === 'visible') request(w.navigator, pip);
}

function releaseAll(): void {
  for (const slot of [main, pip]) {
    if (live(slot)) void slot.lock!.release().catch(() => {});
    slot.lock = null;
  }
  emit();
}

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('visibilitychange', acquire);
  document.addEventListener('pointerdown', acquire, true);
  subscribePip(() => {
    if (!pipWindow()) pip.lock = null;
    acquire();
  });
}

/** Turns this controller's wish for the lock on or off. */
export function setWakeWanted(owner: string, on: boolean): void {
  if (!wakeLockSupported) return;
  install();
  if (on) {
    wanted.add(owner);
    acquire();
  } else if (wanted.delete(owner) && wanted.size === 0) {
    releaseAll();
  }
}

export function wakeLockHeld(): boolean {
  return live(main) || live(pip);
}

export function subscribeWakeLock(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
