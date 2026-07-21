import { describe, it, expect } from 'vitest';
import { expandByDay, collapseToTransitions, daySegments, parseOffsetMin, fmtMin } from './schedule';
import type { Schedule } from './types';

const SCH: Schedule = {
  id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' },
  apply: 'climate_temperature', default: { value: null },
  transitions: [
    { id: 't1', when: { type: 'time', at: '20:00' }, value: 80, weekdays: ['mon', 'tue'] },
    { id: 't2', when: { type: 'anchor', entity: 'input_datetime.wakeup_time', offset: '-00:30' }, value: 95, weekdays: ['mon'] },
  ],
};
const hass = { connection: {} as any, states: { 'input_datetime.wakeup_time': { state: '06:30:00' } } } as any;

describe('schedule', () => {
  it('parseOffsetMin handles signs', () => {
    expect(parseOffsetMin('-00:30')).toBe(-30);
    expect(parseOffsetMin('+01:15')).toBe(75);
  });
  it('expandByDay puts transitions on each of their weekdays', () => {
    const by = expandByDay(SCH);
    expect(by.mon.length).toBe(2);
    expect(by.tue.length).toBe(1);
    expect(by.wed.length).toBe(0);
  });
  it('collapseToTransitions writes single-day weekdays', () => {
    const by = expandByDay(SCH);
    const flat = collapseToTransitions(by);
    // mon has 2 + tue has 1 = 3 transitions, each single-day
    expect(flat.length).toBe(3);
    expect(flat.every((t) => t.weekdays!.length === 1)).toBe(true);
  });
  it('daySegments builds a wrapping step function resolving anchors', () => {
    const by = expandByDay(SCH);
    const segs = daySegments(by.mon, hass); // anchor 06:30-00:30 = 06:00 -> 95; 20:00 -> 80
    // value held from 00:00 is the last entry (20:00 -> 80)
    expect(segs[0].value).toBe(80);
    const at6 = segs.find((s) => s.m0 === 360);
    expect(at6?.value).toBe(95);
    expect(fmtMin(360)).toBe('06:00');
  });
});
