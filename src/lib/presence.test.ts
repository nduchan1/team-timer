import { describe, expect, it } from 'vitest';
import type { PresenceEntry } from '../sync/SyncAdapter.ts';
import { dutyView, groupPeople, normName } from './presence.ts';

const e = (cid: string, name: string, onDuty = false): PresenceEntry => ({ cid, name, onDuty });

describe('normName', () => {
  it('ignores case and extra spaces', () => {
    expect(normName('  Dys   Closure ')).toBe('dys closure');
    expect(normName('KVIS')).toBe(normName('kvis'));
  });
});

describe('dutyView', () => {
  const me = e('me', 'Dysclosure');

  it('counts my other device as mine, not as someone else', () => {
    const v = dutyView([e('me', 'Dysclosure'), e('pc', ' dysclosure ', true)], me);
    expect(v).toEqual({ mine: true, others: [] });
  });

  it('ignores this tab’s own (possibly stale) entry', () => {
    const v = dutyView([e('me', 'Dysclosure', true)], me);
    expect(v).toEqual({ mine: false, others: [] });
  });

  it('lists other people on duty once each', () => {
    const v = dutyView([e('a', 'kvislion', true), e('b', 'Kvislion', true), e('c', '_oet')], { ...me, onDuty: true });
    expect(v).toEqual({ mine: true, others: ['kvislion'] });
  });
});

describe('groupPeople', () => {
  it('merges a person’s devices and puts people on duty first', () => {
    const list = groupPeople(
      [e('a', '_oet'), e('pc', 'Dysclosure', true), e('phone', 'dysclosure'), e('me', 'nd2486', true)],
      e('me', 'nd2486', false),
    );
    expect(list).toEqual([
      { key: 'dysclosure', name: 'Dysclosure', devices: 2, onDuty: true, me: false },
      { key: '_oet', name: '_oet', devices: 1, onDuty: false, me: false },
      { key: 'nd2486', name: 'nd2486', devices: 1, onDuty: false, me: true },
    ]);
  });

  it('shows my name as I typed it when another device spells it differently', () => {
    const list = groupPeople([e('pc', 'ND2486', true)], e('me', 'nd2486'));
    expect(list).toEqual([{ key: 'nd2486', name: 'nd2486', devices: 2, onDuty: true, me: true }]);
  });

  it('leaves this tab out before it joins', () => {
    expect(groupPeople([e('a', 'kvislion')], null)).toHaveLength(1);
  });
});
