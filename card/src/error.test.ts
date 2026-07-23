import { describe, it, expect, beforeEach } from 'vitest';
import './card';
import type { Schedule } from './types';

const SCH: Schedule = { id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' },
  apply: 'climate_temperature', on_mode: 'heat', default: { value: null },
  transitions: [{ id: 't1', when: { type: 'time', at: '20:00' }, value: { mode: null, temp: 80 }, weekdays: ['mon','tue','wed','thu','fri','sat','sun'] }] };

async function flush(el: any) { for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; } }

describe('error handling', () => {
  beforeEach(() => (document.body.innerHTML = ''));
  it('shows an error when loading fails', async () => {
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'nope' }); document.body.appendChild(el);
    el.hass = { connection: { sendMessagePromise: async () => { throw new Error('not_found'); } }, states: {} };
    await flush(el);
    expect(el.shadowRoot.textContent).toContain("Couldn't load");
  });
  it('keeps dirty and shows an error when save fails', async () => {
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    el.hass = { connection: { sendMessagePromise: async (m: any) => {
      if (m.type === 'timeline_scheduler/get') return SCH;
      if (m.type === 'timeline_scheduler/save') throw new Error('unauthorized');
      return { schedules: [SCH] };
    } }, states: {} };
    await flush(el);
    el._addSetpoint(); await el.updateComplete;
    await el._sync();
    expect(el._dirty).toBe(true);
    expect(el.shadowRoot.textContent).toContain('Save failed');
  });
});
