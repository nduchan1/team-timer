// Room IDs are 128 random bits as 22 base64url characters. The ID lives in the URL hash, so it never
// reaches the server (no logs, no Referer). The link is the key, like the dual's shared password.

const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isRoomId(s: string): boolean {
  return ROOM_RE.test(s);
}

/** Room ID from a location hash ("#abc…"), or null. */
export function parseHash(hash: string): string | null {
  const id = hash.replace(/^#\/?/, '');
  return isRoomId(id) ? id : null;
}

export type Route =
  | { page: 'room'; roomId: string }
  /** The oasis helper; with a room id it can also use the team's uploaded map data. */
  | { page: 'oases'; roomId: string | null }
  | { page: 'landing'; bad: boolean };

/** Page for a location hash: "#<room>", "#<room>/oases", "#/oases", or the landing page. */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (!h) return { page: 'landing', bad: false };
  if (isRoomId(h)) return { page: 'room', roomId: h };
  const m = /^(?:([A-Za-z0-9_-]{22})\/)?oases\/?$/.exec(h);
  if (m) return { page: 'oases', roomId: m[1] ?? null };
  return { page: 'landing', bad: true };
}

/** Room ID from a pasted link (also an oasis-helper link) or a bare code, or null. */
export function parseRoomInput(text: string): string | null {
  const s = text.trim();
  if (isRoomId(s)) return s;
  const i = s.lastIndexOf('#');
  if (i < 0) return null;
  const r = parseRoute(s.slice(i));
  return r.page === 'landing' ? null : r.roomId;
}

export function roomLink(id: string): string {
  return `${location.origin}${location.pathname}#${id}`;
}
