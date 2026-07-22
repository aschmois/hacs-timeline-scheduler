import { describe, it, expect, beforeEach } from 'vitest';
import './card';
import { fmtClock, isTemp } from './schedule';
import type { Schedule } from './types';

describe('fmtClock', () => {
  it('formats 12-hour AM/PM by default', () => {
    expect(fmtClock(0)).toBe('12:00 AM');
    expect(fmtClock(12 * 60)).toBe('12:00 PM');
    expect(fmtClock(13 * 60)).toBe('1:00 PM');
    expect(fmtClock(9 * 60 + 5)).toBe('9:05 AM');
  });
  it('honors the HA 24-hour locale', () => {
    expect(fmtClock(13 * 60, { locale: { time_format: '24' } } as any)).toBe('13:00');
  });
});

describe('isTemp', () => {
  it('numbers are temperatures, strings are modes', () => {
    expect(isTemp(72)).toBe(true);
    expect(isTemp('auto')).toBe(false);
  });
});

const SCH: Schedule = {
  id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature',
  default: null,
  transitions: [
    { id: 't1', when: { type: 'time', at: '20:00' }, value: 72, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
    { id: 't2', when: { type: 'time', at: '23:00' }, value: 'off', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  ],
};
function mkHass() {
  return {
    connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }) },
    states: { 'climate.bed': { state: 'heat', attributes: { hvac_modes: ['off', 'auto', 'heat', 'cool'] } } },
    config: { unit_system: { temperature: '°F' } },
  } as any;
}
async function mount() {
  const el = document.createElement('timeline-scheduler-card') as any;
  el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el); el.hass = mkHass();
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
  return el;
}

describe('card v2', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('is locked by default: no footer/detail editing UI, lock button present', async () => {
    const el = await mount();
    expect(el._locked).toBe(true);
    expect(el.shadowRoot.querySelector('.foot')).toBeNull();
    expect(el.shadowRoot.querySelector('.detail')).toBeNull();
    expect(el.shadowRoot.querySelector('.lock')).toBeTruthy();
  });

  it('renders a temperature and a mode setpoint (mode band present)', async () => {
    const el = await mount();
    const txt = el.shadowRoot.textContent;
    expect(txt).toContain('72°');
    expect(txt).toContain('Off');
    expect(el.shadowRoot.querySelectorAll('.dot').length).toBe(2);
    expect(el.shadowRoot.querySelector('rect.seg-mode')).toBeTruthy();
  });

  it('unit follows HA and can be overridden by config', async () => {
    const el = await mount();
    expect(el._unit()).toBe('F');
    el.setConfig({ schedule_id: 'bed', unit: 'C' }); await el.updateComplete;
    expect(el._unit()).toBe('C');
  });

  it('lists setpoints ordered by resolved time', async () => {
    const el = await mount();
    el._day = 'mon';
    el._perDay.mon = [
      { id: 'a', kind: 'time', atMin: 23 * 60, value: 70 },
      { id: 'b', kind: 'time', atMin: 6 * 60, value: 72 },
      { id: 'c', kind: 'time', atMin: 12 * 60, value: 68 },
    ];
    expect(el._sortedDay().map((e: any) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('override / resume send the right WS commands', async () => {
    const sent: any[] = [];
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    el.hass = {
      connection: { sendMessagePromise: async (m: any) => { sent.push(m); return m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }; } },
      states: { 'climate.bed': { state: 'heat', attributes: { hvac_modes: ['off', 'auto', 'heat', 'cool'] } } },
      config: { unit_system: { temperature: '°F' } },
    };
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    await el._doOverride(66);
    expect(sent.some((m) => m.type === 'timeline_scheduler/override' && m.value === 66 && m.id_ === 'bed')).toBe(true);
    await el._clearOverride();
    expect(sent.some((m) => m.type === 'timeline_scheduler/clear_override' && m.id_ === 'bed')).toBe(true);
  });

  it('unlocked + selected mode point shows a mode picker built from the device hvac_modes', async () => {
    const el = await mount();
    el._toggleLock();
    const modeEntry = el._activeDay().find((e: any) => typeof e.value === 'string');
    el._sel = modeEntry.id; await el.updateComplete;
    expect(el.shadowRoot.querySelector('.detail')).toBeTruthy();
    const opts = [...el.shadowRoot.querySelectorAll('.detail select.sel option')].map((o: any) => o.value);
    expect(opts).toContain('heat');
    expect(opts).toContain('cool');
  });
});
