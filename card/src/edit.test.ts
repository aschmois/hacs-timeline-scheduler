import { describe, it, expect, beforeEach, vi } from 'vitest';
import './card';
import type { Schedule } from './types';

const SCH: Schedule = {
  id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature',
  default: { value: null }, transitions: [{ id: 't1', when: { type: 'time', at: '20:00' }, value: 80, weekdays: ['mon','tue','wed','thu','fri','sat','sun'] }],
};
function mkHass(saved: any[]) {
  return { connection: { sendMessagePromise: vi.fn(async (m: any) => {
    if (m.type === 'timeline_scheduler/get') return SCH;
    if (m.type === 'timeline_scheduler/save') { saved.push(m.schedule); return m.schedule; }
    return { schedules: [SCH] };
  }) }, states: {} } as any;
}
async function mount(saved: any[]) {
  const el = document.createElement('timeline-scheduler-card') as any;
  el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el); el.hass = mkHass(saved);
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
  return el;
}

describe('editing', () => {
  beforeEach(() => (document.body.innerHTML = ''));
  it('add setpoint marks dirty and enables save', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._addSetpoint(); await el.updateComplete;
    expect(el._dirty).toBe(true);
    const save = el.shadowRoot.querySelector('button.save');
    expect(save.disabled).toBe(false);
  });
  it('save collapses per-day map to single-day transitions', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._addSetpoint(); await el._save();
    expect(saved.length).toBe(1);
    // original 1 (×7 days expanded) + the new one on the active day, all single-day
    expect(saved[0].transitions.every((t: any) => t.weekdays.length === 1)).toBe(true);
    expect(saved[0].transitions.length).toBe(8);
  });
});
