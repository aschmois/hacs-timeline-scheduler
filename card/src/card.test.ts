import { describe, it, expect, beforeEach } from 'vitest';
import './card';
import type { Schedule } from './types';

const SCH: Schedule = {
  id: 'bed', name: 'Bedroom Bed', enabled: true, target: { entity_id: 'climate.bed' },
  apply: 'climate_temperature', on_mode: 'heat', default: { value: null },
  transitions: [
    { id: 't1', when: { type: 'time', at: '20:00' }, value: { mode: null, temp: 80 }, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
    { id: 't2', when: { type: 'time', at: '02:00' }, value: { mode: null, temp: 83 }, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  ],
};
function mkHass() {
  return { connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }) }, states: {} } as any;
}
async function mount() {
  const el = document.createElement('timeline-scheduler-card') as any;
  el.setConfig({ schedule_id: 'bed' });
  document.body.appendChild(el);
  el.hass = mkHass();
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

describe('timeline-scheduler-card', () => {
  beforeEach(() => (document.body.innerHTML = ''));
  it('renders the schedule name and a dot per transition for the active day', async () => {
    const el = await mount();
    const txt = el.shadowRoot.textContent;
    expect(txt).toContain('Bedroom Bed');
    const dots = el.shadowRoot.querySelectorAll('.dot');
    expect(dots.length).toBe(2); // both transitions apply every day
  });
  it('throws on missing config', () => {
    const el = document.createElement('timeline-scheduler-card') as any;
    expect(() => el.setConfig(undefined)).toThrow();
  });
});
