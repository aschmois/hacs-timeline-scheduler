import { describe, it, expect, beforeEach } from 'vitest';
import './card';
import { fmtClock, vTemp, vMode } from './schedule';
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

describe('value accessors', () => {
  it('read temp and mode from a climate value object', () => {
    expect(vTemp({ mode: null, temp: 72 })).toBe(72);
    expect(vMode({ mode: null, temp: 72 })).toBe(null);
    expect(vMode({ mode: 'off', temp: null })).toBe('off');
    expect(vTemp({ mode: 'off', temp: null })).toBe(null);
  });
});

const SCH: Schedule = {
  id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature',
  on_mode: 'heat', default: null,
  transitions: [
    { id: 't1', when: { type: 'time', at: '20:00' }, value: { mode: null, temp: 72 }, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
    { id: 't2', when: { type: 'time', at: '23:00' }, value: { mode: 'off', temp: null }, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
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

  it('renders a temperature and a mode (off) setpoint (mode band present)', async () => {
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
      { id: 'a', kind: 'time', atMin: 23 * 60, value: { mode: null, temp: 70 } },
      { id: 'b', kind: 'time', atMin: 6 * 60, value: { mode: null, temp: 72 } },
      { id: 'c', kind: 'time', atMin: 12 * 60, value: { mode: null, temp: 68 } },
    ];
    expect(el._sortedDay().map((e: any) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it("overlays today's actual + set-to history for a climate schedule", async () => {
    const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() / 1000; };
    const hist: any = { 'climate.bed': [
      { s: 'heat', a: { current_temperature: 68, temperature: 72 }, lu: at(6) },
      { s: 'heat', a: { current_temperature: 70, temperature: 74 }, lu: at(12) },
    ] };
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    el.hass = {
      connection: { sendMessagePromise: async (m: any) =>
        (m.type === 'history/history_during_period' ? hist
          : m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }) },
      states: { 'climate.bed': { state: 'heat', attributes: { hvac_modes: ['off', 'auto', 'heat', 'cool'], current_temperature: 70, temperature: 74 } } },
      config: { unit_system: { temperature: '°F' } },
    };
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    expect(el._hist.actual.length).toBe(2);
    expect(el._hist.targetRuns.length).toBe(1);
    expect(el._hist.targetRuns[0].length).toBe(2);
    expect(el.shadowRoot.querySelector('polyline.hist-actual')).toBeTruthy();
    expect(el.shadowRoot.querySelector('polyline.hist-target')).toBeTruthy();
    expect(el.shadowRoot.querySelector('.legend')).toBeTruthy();
  });

  it('breaks the set-to history line while the climate was off (no stale target)', async () => {
    const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() / 1000; };
    const hist: any = { 'climate.bed': [
      { s: 'heat', a: { current_temperature: 68, temperature: 72 }, lu: at(6) },
      { s: 'heat', a: { current_temperature: 69, temperature: 72 }, lu: at(7) },
      { s: 'off', a: { current_temperature: 70, temperature: 72 }, lu: at(9) }, // off but temperature still 72
      { s: 'heat', a: { current_temperature: 71, temperature: 74 }, lu: at(12) },
      { s: 'heat', a: { current_temperature: 72, temperature: 74 }, lu: at(13) },
    ] };
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    el.hass = {
      connection: { sendMessagePromise: async (m: any) =>
        (m.type === 'history/history_during_period' ? hist
          : m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }) },
      states: { 'climate.bed': { state: 'heat', attributes: { hvac_modes: ['off', 'auto', 'heat', 'cool'], current_temperature: 72, temperature: 74 } } },
      config: { unit_system: { temperature: '°F' } },
    };
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    expect(el._hist.targetRuns.length).toBe(2); // off splits the two active runs
    expect(el.shadowRoot.querySelectorAll('polyline.hist-target').length).toBe(2);
    expect(el._hist.actual.length).toBe(5); // actual measurement stays continuous
  });

  it('shows an Override badge + Resume when the target temperature diverges', async () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const SC: any = {
      id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature',
      on_mode: 'heat', default: null,
      transitions: [{ id: 'a', when: { type: 'time', at: '00:00' }, value: { mode: null, temp: 70 }, weekdays: days }],
    };
    const sent: any[] = [];
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    el.hass = {
      connection: { sendMessagePromise: async (m: any) => { sent.push(m); return m.type === 'timeline_scheduler/get' ? SC : { schedules: [SC] }; } },
      states: { 'climate.bed': { state: 'heat', attributes: { temperature: 66, hvac_modes: ['off', 'auto', 'heat', 'cool'] } } },
      config: { unit_system: { temperature: '°F' } },
    };
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    expect(el._overrideInfo().active).toBe(true); // scheduled 70 in heat, actual heat@66
    expect(el.shadowRoot.querySelector('.ovbadge')).toBeTruthy();
    el.shadowRoot.querySelector('.reslink').click();
    await el.updateComplete;
    expect(sent.some((m: any) => m.type === 'timeline_scheduler/clear_override' && m.id_ === 'bed')).toBe(true);
  });

  it('temperature axis uses the device min_temp/max_temp', async () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const SC: any = {
      id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature',
      on_mode: 'auto', default: null,
      transitions: [{ id: 'a', when: { type: 'time', at: '20:00' }, value: { mode: null, temp: 72 }, weekdays: days }],
    };
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    el.hass = {
      connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? SC : { schedules: [SC] }) },
      states: { 'climate.bed': { state: 'auto', attributes: { min_temp: 55, max_temp: 118, temperature: 72, hvac_modes: ['off', 'auto'] } } },
      config: { unit_system: { temperature: '°F' } },
    };
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    expect(el._scale().tmin).toBe(55);
    expect(el._scale().tmax).toBe(118);
  });

  it('a mode-only setpoint compares hvac state, not temperature', async () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const SC: any = {
      id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature', default: null,
      transitions: [{ id: 'a', when: { type: 'time', at: '00:00' }, value: { mode: 'auto', temp: null }, weekdays: days }],
    };
    const mk = (state: string) => ({
      connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? SC : { schedules: [SC] }) },
      states: { 'climate.bed': { state, attributes: { temperature: 73, hvac_modes: ['off', 'auto'] } } },
      config: { unit_system: { temperature: '°F' } },
    });
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el); el.hass = mk('auto');
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    expect(el._overrideInfo().active).toBe(false); // scheduled auto, actual auto -> not overridden
    el.hass = mk('off'); await el.updateComplete;
    expect(el._overrideInfo().active).toBe(true); // scheduled auto, actual off -> overridden
  });

  it('renders a simple On/Off view for switch_onoff schedules (no temperature axis)', async () => {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const SW: any = {
      id: 'shed', name: 'Shed', enabled: true, target: { entity_id: 'switch.shed' }, apply: 'switch_onoff', default: null,
      transitions: [
        { id: 'a', when: { type: 'time', at: '08:00' }, value: { state: 'on' }, weekdays: days },
        { id: 'b', when: { type: 'time', at: '20:00' }, value: { state: 'off' }, weekdays: days },
      ],
    };
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'shed' }); document.body.appendChild(el);
    el.hass = { connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? SW : { schedules: [SW] }) }, states: {} };
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    const axisTexts = [...el.shadowRoot.querySelectorAll('text.axis')].map((t: any) => t.textContent);
    expect(axisTexts).toContain('On');
    expect(axisTexts).toContain('Off');
    expect(axisTexts.some((t: string) => t && t.includes('°'))).toBe(false); // no temperature axis
    expect(el.shadowRoot.querySelectorAll('.dot').length).toBe(2);
  });

  it('override sends the temperature as a climate value object; resume clears it', async () => {
    const sent: any[] = [];
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    el.hass = {
      connection: { sendMessagePromise: async (m: any) => { sent.push(m); return m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }; } },
      states: { 'climate.bed': { state: 'heat', attributes: { hvac_modes: ['off', 'auto', 'heat', 'cool'] } } },
      config: { unit_system: { temperature: '°F' } },
    };
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    await el._doOverride({ mode: null, temp: 66 });
    expect(sent.some((m) => m.type === 'timeline_scheduler/override' && m.value && m.value.temp === 66 && m.id_ === 'bed')).toBe(true);
    await el._clearOverride();
    expect(sent.some((m) => m.type === 'timeline_scheduler/clear_override' && m.id_ === 'bed')).toBe(true);
  });

  it('unlocked + selected setpoint shows a mode picker built from the device hvac_modes', async () => {
    const el = await mount();
    el._toggleLock();
    const modeEntry = el._activeDay().find((e: any) => vMode(e.value) !== null); // the "off" setpoint
    el._sel = modeEntry.id; await el.updateComplete;
    expect(el.shadowRoot.querySelector('.detail')).toBeTruthy();
    const opts = [...el.shadowRoot.querySelectorAll('.detail select.sel option')].map((o: any) => o.value);
    expect(opts).toContain('heat');
    expect(opts).toContain('cool');
  });

  it('a temperature-only setpoint turns on using the schedule on_mode (Turn on as picker)', async () => {
    const el = await mount();
    el._toggleLock(); await el.updateComplete;
    // The "Turn on as" row reflects the schedule's on_mode.
    const onmode = el.shadowRoot.querySelector('.onmode select.sel') as HTMLSelectElement;
    expect(onmode).toBeTruthy();
    expect(onmode.value).toBe('heat');
  });
});
