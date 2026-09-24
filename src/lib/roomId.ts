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

/** Room ID from a pasted link or a bare code, or null. */
export function parseRoomInput(text: string): string | null {
  const s = text.trim();
  if (isRoomId(s)) return s;
  const i = s.lastIndexOf('#');
  return i >= 0 ? parseHash(s.slice(i)) : null;
}

export function roomLink(id: string): string {
  return `${location.origin}${location.pathname}#${id}`;
}
