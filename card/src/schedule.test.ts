import { describe, it, expect } from 'vitest';
import { expandByDay, collapseToTransitions, daySegments, parseOffsetMin, fmtMin, resolveMin, fmtClock, vTemp } from './schedule';
import type { Schedule } from './types';

const SCH: Schedule = {
  id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' },
  apply: 'climate_temperature', on_mode: 'heat', default: { value: null },
  transitions: [
    { id: 't1', when: { type: 'time', at: '20:00' }, value: { mode: null, temp: 80 }, weekdays: ['mon', 'tue'] },
    { id: 't2', when: { type: 'anchor', entity: 'input_datetime.wakeup_time', offset: '-00:30' }, value: { mode: null, temp: 95 }, weekdays: ['mon'] },
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
  it('resolveMin parses ISO datetime anchor states (sun_next_dawn) and plain clocks', () => {
    const e = { id: 'x', kind: 'anchor', entity: 'sensor.sun_next_dawn', offsetMin: 0, value: { mode: null, temp: 70 } } as any;
    // local-time ISO (no tz) parses deterministically as 10:30 local
    const isoHass = { states: { 'sensor.sun_next_dawn': { state: '2026-07-22T10:30:00' } } } as any;
    expect(resolveMin(e, isoHass)).toBe(10 * 60 + 30);
    // plain clock still works
    const clockHass = { states: { 'sensor.sun_next_dawn': { state: '06:45:00' } } } as any;
    expect(resolveMin(e, clockHass)).toBe(6 * 60 + 45);
    // unparseable -> null (not NaN), so display shows "—" not "12:NaN PM"
    const badHass = { states: { 'sensor.sun_next_dawn': { state: 'above_horizon' } } } as any;
    expect(resolveMin(e, badHass)).toBeNull();
    expect(fmtClock(NaN)).toBe('—');
  });

  it('daySegments builds a wrapping step function resolving anchors', () => {
    const by = expandByDay(SCH);
    const segs = daySegments(by.mon, hass); // anchor 06:30-00:30 = 06:00 -> 95; 20:00 -> 80
    // value held from 00:00 is the last entry (20:00 -> 80)
    expect(vTemp(segs[0].value)).toBe(80);
    const at6 = segs.find((s) => s.m0 === 360);
    expect(vTemp(at6?.value)).toBe(95);
    expect(fmtMin(360)).toBe('06:00');
  });
});
