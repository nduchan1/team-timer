import { describe, expect, it } from 'vitest';
import { createVersionCheck } from './version.ts';

function setup(deployed: string | null | Error) {
  let t = 0;
  let calls = 0;
  const check = createVersionCheck(
    'b1',
    async () => {
      calls++;
      if (deployed instanceof Error) throw deployed;
      return deployed;
    },
    () => t,
    600_000,
    60_000,
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { check, flush, advance: (ms: number) => (t += ms), calls: () => calls };
}

describe('version check', () => {
  it('flags a different deployed build', async () => {
    const s = setup('b2');
    let notified = 0;
    s.check.subscribe(() => notified++);
    s.check.maybeCheck();
    await s.flush();
    expect(s.check.updateReady).toBe(true);
    expect(notified).toBe(1);
  });

  it('stays quiet for the same build, an unknown id or a failed fetch', async () => {
    for (const deployed of ['b1', null, new Error('offline')]) {
      const s = setup(deployed);
      s.check.maybeCheck();
      await s.flush();
      expect(s.check.updateReady).toBe(false);
    }
  });

  it('checks at most every 10 min, or every minute when forced', async () => {
    const s = setup('b1');
    s.check.maybeCheck();
    await s.flush();
    s.advance(30_000);
    s.check.maybeCheck(true); // tab focus 30 s later: too soon
    s.check.maybeCheck();
    await s.flush();
    expect(s.calls()).toBe(1);
    s.advance(40_000);
    s.check.maybeCheck(true); // 70 s after the first
    await s.flush();
    expect(s.calls()).toBe(2);
    s.advance(300_000);
    s.check.maybeCheck(); // only 5 min after the last
    await s.flush();
    expect(s.calls()).toBe(2);
    s.advance(300_000);
    s.check.maybeCheck();
    await s.flush();
    expect(s.calls()).toBe(3);
  });
});
