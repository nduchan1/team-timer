// Travian's international worlds run on UK time (GMT in winter, BST in summer), and the team plans in
// it ("22:00 ST"). The IANA zone follows the clock changes; a fixed offset would be wrong half the year.

const ZONE = 'Europe/London';

const st = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const stShort = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const localShort24 = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Server time of an epoch instant, 24-hour: "14:09:08", or "14:09" without seconds. */
export function formatServerTime(epochMs: number, withSeconds = true): string {
  return (withSeconds ? st : stShort).format(epochMs);
}

/** True when this browser's clock reads the same as server time at that instant (a UK player). */
export function sameAsServerTime(epochMs: number): boolean {
  return localShort24.format(epochMs) === stShort.format(epochMs);
}
