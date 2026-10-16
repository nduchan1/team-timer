// Notices a new deploy while a timer tab stays open for days: the build id baked into this bundle is
// compared with /version.json, which every build writes (see vite.config.ts).

export interface VersionCheck {
  /** A newer build is deployed. */
  readonly updateReady: boolean;
  /** Checks unless the last check was under everyMs ago (minGapMs with force, e.g. on tab focus). */
  maybeCheck(force?: boolean): void;
  subscribe(cb: () => void): () => void;
}

export function createVersionCheck(
  currentId: string,
  fetchId: () => Promise<string | null>,
  now: () => number,
  everyMs = 10 * 60_000,
  minGapMs = 60_000,
): VersionCheck {
  let last = -Infinity;
  let inflight = false;
  let ready = false;
  const listeners = new Set<() => void>();
  return {
    get updateReady() {
      return ready;
    },
    maybeCheck(force = false) {
      if (ready || inflight) return;
      const t = now();
      if (t - last < (force ? minGapMs : everyMs)) return;
      last = t;
      inflight = true;
      fetchId()
        .then((id) => {
          if (id === null || id === currentId) return;
          ready = true;
          for (const cb of listeners) cb();
        })
        .catch(() => {
          // offline: try again next time
        })
        .finally(() => {
          inflight = false;
        });
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** The deployed build id, or null when unknown (dev server, which answers with index.html; not JSON). */
async function fetchDeployedId(): Promise<string | null> {
  const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : null;
}

export const versionCheck = createVersionCheck(__BUILD_ID__, fetchDeployedId, () => performance.now());
