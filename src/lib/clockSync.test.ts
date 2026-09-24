import { describe, expect, it } from 'vitest';
import { ClockSync, type ClockDeps } from './clockSync.ts';

/** A fake world: a local perf clock, a PC wall clock, and a server clock that is `trueOffset` ahead of perf. */
function world(opts: { trueOffset: number; up?: number | (() => number); down?: number | (() => number); wallOffset?: number }) {
  let perf = 1000;
  let wallOffset = opts.wallOffset ?? 1_750_000_000_000;
  let calls = 0;
  const val = (v: number | (() => number) | undefined) => (typeof v === 'function' ? v() : (v ?? 20));
  const deps: ClockDeps = {
    perfNow: () => perf,
    wallNow: () => perf + wallOffset,
    sleep: async (ms) => {
      perf += ms;
    },
    sample: async () => {
      calls++;
      const t0 = perf;
      perf += val(opts.up);
      const serverMs = perf + opts.trueOffset;
      perf += val(opts.down);
      return { t0, t3: perf, serverMs };
    },
  };
  return {
    deps,
    advance: (ms: number) => {
      perf += ms;
    },
    jumpWall: (ms: number) => {
      wallOffset += ms;
    },
    calls: () => calls,
  };
}

describe('ClockSync', () => {
  it('starts from the PC clock', () => {
    const w = world({ trueOffset: 5e12 });
    const c = new ClockSync(w.deps);
    expect(c.quality).toBe('none');
    expect(c.serverNow()).toBe(w.deps.wallNow());
  });

  it('is exact with symmetric delays', async () => {
    const w = world({ trueOffset: 1_750_000_037_000, up: 25, down: 25 });
    const c = new ClockSync(w.deps);
    expect(await c.sync()).toBe(true);
    expect(c.offset).toBeCloseTo(1_750_000_037_000, 6);
    expect(c.quality).toBe('precise');
    expect(c.errorMs).toBe(25);
  });

  it('stays within rtt/2 with asymmetric delays', async () => {
    const trueOffset = 1_750_000_000_000;
    const w = world({ trueOffset, up: 10, down: 50 });
    const c = new ClockSync(w.deps);
    await c.sync();
    expect(Math.abs(c.offset - trueOffset)).toBeLessThanOrEqual(c.errorMs);
    expect(c.errorMs).toBe(30);
  });

  it('filters high-rtt outliers and reports max accepted rtt / 2', async () => {
    const trueOffset = 1_750_000_000_000;
    const ups = [300, 20, 20, 400, 20, 22];
    let i = 0;
    const w = world({ trueOffset, up: () => ups[i++ % ups.length], down: 20 });
    const c = new ClockSync(w.deps);
    await c.sync();
    // the 400 ms sample is dropped; accepted rtts are 40, 40, 40, 42 → error 21
    expect(c.errorMs).toBe(21);
    expect(Math.abs(c.offset - trueOffset)).toBeLessThanOrEqual(1);
  });

  it('rate-limits rounds to one per 30 s unless forced, and shares one round between concurrent calls', async () => {
    const w = world({ trueOffset: 0 });
    const c = new ClockSync(w.deps);
    const [a, b] = await Promise.all([c.sync(), c.sync()]);
    expect(a && b).toBe(true);
    expect(w.calls()).toBe(6); // 1 warm-up + 5 samples, once
    expect(await c.sync()).toBe(false);
    expect(w.calls()).toBe(6);
    expect(await c.sync(true)).toBe(true);
    expect(w.calls()).toBe(12);
  });

  it('rejects a congested round once a precise offset exists, unless forced', async () => {
    let rtt = 10;
    const w = world({ trueOffset: 0, up: () => rtt, down: () => rtt });
    const c = new ClockSync(w.deps);
    await c.sync();
    rtt = 200;
    w.advance(31_000);
    expect(await c.sync()).toBe(false);
    expect(c.rejected).toBe(1);
    expect(await c.sync(true)).toBe(true);
  });

  it('decays the best rtt after 3 rejections so a slower network is accepted again', async () => {
    let rtt = 10;
    const w = world({ trueOffset: 0, up: () => rtt, down: () => rtt });
    const c = new ClockSync(w.deps);
    await c.sync();
    rtt = 200;
    for (let i = 0; i < 3; i++) {
      w.advance(31_000);
      expect(await c.sync()).toBe(false);
    }
    w.advance(31_000);
    expect(await c.sync()).toBe(true);
  });

  it('keeps the offset valid when the PC clock jumps, and forces a round', async () => {
    const trueOffset = 1_750_000_000_000;
    const w = world({ trueOffset, up: 20, down: 20 });
    const c = new ClockSync(w.deps);
    await c.sync();
    const offsetBefore = c.offset;
    c.tick();
    w.advance(250);
    w.jumpWall(120_000); // user moves the PC clock 2 min ahead
    c.tick();
    expect(c.offset).toBe(offsetBefore); // serverNow is unaffected by the wall jump
    expect(w.calls()).toBeGreaterThan(6); // a forced round started
    await c.sync();
    expect(Math.abs(c.offset - trueOffset)).toBeLessThanOrEqual(c.errorMs);
  });

  it('does not fire the jump detector for sub-second steps', async () => {
    const w = world({ trueOffset: 0 });
    const c = new ClockSync(w.deps);
    await c.sync();
    const n = w.calls();
    c.tick();
    w.advance(250);
    w.jumpWall(500);
    c.tick();
    expect(w.calls()).toBe(n);
  });

  it('runs a periodic round after 5 min', async () => {
    const w = world({ trueOffset: 0 });
    const c = new ClockSync(w.deps);
    await c.sync();
    c.tick();
    w.advance(301_000);
    c.tick();
    expect(w.calls()).toBe(7); // the new round has started its warm-up sample
  });

  it('uses the rough offset only until a precise one exists', async () => {
    const w = world({ trueOffset: 1_750_000_000_000 + 5000, wallOffset: 1_750_000_000_000 });
    const c = new ClockSync(w.deps);
    c.setRough(4800);
    expect(c.quality).toBe('rough');
    expect(c.offset).toBe(1_750_000_000_000 + 4800);
    await c.sync();
    c.setRough(0);
    expect(c.quality).toBe('precise');
    expect(Math.abs(c.offset - (1_750_000_000_000 + 5000))).toBeLessThanOrEqual(c.errorMs);
  });

  it('reports how far the PC clock is off', async () => {
    const w = world({ trueOffset: 1_750_000_000_000 + 37_000, wallOffset: 1_750_000_000_000, up: 5, down: 5 });
    const c = new ClockSync(w.deps);
    await c.sync();
    expect(Math.round(c.pcClockErrorMs() / 1000)).toBe(37);
  });

  it('after a jump, accepts a fresh rough offset and retries a failed forced round every 10 s', async () => {
    let online = true;
    const w = world({ trueOffset: 1_750_000_000_000, wallOffset: 1_750_000_000_000, up: 20, down: 20 });
    const c = new ClockSync({ ...w.deps, sample: () => (online ? w.deps.sample() : Promise.reject(new Error('offline'))) });
    const steps: [number, string][] = [];
    c.onChange((d, prev) => steps.push([Math.round(d), prev]));
    await c.sync();
    expect(steps).toEqual([[0, 'none']]);
    // PC wakes from sleep with the network still down
    c.tick();
    online = false;
    w.advance(250);
    w.jumpWall(3_600_000);
    c.tick();
    expect(c.quality).toBe('rough');
    expect(c.needsRound).toBe(true);
    await c.sync(); // shares the in-flight forced round, which fails
    expect(c.needsRound).toBe(true);
    c.setRough(-3_600_000 + 0); // reconnect handshake: server = Date.now() + offset
    expect(steps.at(-1)?.[1]).toBe('rough');
    online = true;
    w.advance(5_000);
    c.tick(); // not yet: retry gap is 10 s
    expect(c.needsRound).toBe(true);
    w.advance(6_000);
    c.tick();
    await c.sync();
    expect(c.needsRound).toBe(false);
    expect(c.quality).toBe('precise');
  });

  it('discards a round that a clock jump interrupted', async () => {
    const trueOffset = 1_750_000_000_000;
    const w = world({ trueOffset, wallOffset: trueOffset, up: 20, down: 20 });
    let jumpDuring = false;
    const c = new ClockSync({
      ...w.deps,
      sleep: async (ms) => {
        await w.deps.sleep(ms);
        if (jumpDuring) {
          jumpDuring = false;
          w.jumpWall(3_600_000); // PC slept mid-round; perf did not advance (macOS/Linux)
          c.tick();
        }
      },
    });
    await c.sync();
    c.tick();
    w.advance(301_000);
    jumpDuring = true;
    c.tick(); // periodic round starts, jump lands inside it
    await c.sync();
    expect(c.needsRound).toBe(true);
    expect(c.quality).toBe('rough');
  });

  it('keeps the old offset when samples fail', async () => {
    const w = world({ trueOffset: 0 });
    const c = new ClockSync({ ...w.deps, sample: () => Promise.reject(new Error('offline')) });
    const before = c.offset;
    expect(await c.sync()).toBe(false);
    expect(c.offset).toBe(before);
    expect(c.quality).toBe('none');
  });
});
