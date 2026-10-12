import { describe, it, expect, beforeEach, vi } from 'vitest';
import './card';
import type { Schedule } from './types';

const SCH: Schedule = {
  id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature',
  on_mode: 'heat', default: { value: null }, transitions: [{ id: 't1', when: { type: 'time', at: '20:00' }, value: { mode: null, temp: 80 }, weekdays: ['mon','tue','wed','thu','fri','sat','sun'] }],
};
function mkHass(saved: any[]) {
  return { connection: { sendMessagePromise: vi.fn(async (m: any) => {
    if (m.type === 'timeline_scheduler/get') return SCH;
    if (m.type === 'timeline_scheduler/save_draft') { saved.push(m); return { ...SCH, draft: { transitions: m.transitions, on_mode: m.on_mode } }; }
    if (m.type === 'timeline_scheduler/confirm_draft') { saved.push(m); return { ...SCH, transitions: saved[0].transitions, draft: null }; }
    if (m.type === 'timeline_scheduler/discard_draft') { saved.push(m); return { ...SCH, draft: null }; }
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
  it('add setpoint marks dirty and there is no manual Save button (auto-save)', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._addSetpoint(); await el.updateComplete;
    expect(el._dirty).toBe(true);
    expect(el.shadowRoot.querySelector('button.save')).toBeNull();
  });
  it('sync collapses per-day map to single-day transitions', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._addSetpoint(); await el._sync();
    expect(saved.length).toBe(1);
    // original 1 (×7 days expanded) + the new one on the active day, all single-day
    expect(saved[0].transitions.every((t: any) => t.weekdays.length === 1)).toBe(true);
    expect(saved[0].transitions.length).toBe(8);
    expect(el._dirty).toBe(false);
  });
  it('flushes a pending debounced save when disconnected mid-edit', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._addSetpoint();               // arms the 700ms debounce
    expect(el._dirty).toBe(true);
    expect(saved.length).toBe(0);    // not saved yet
    el.remove();                     // triggers disconnectedCallback -> flush
    await new Promise((r) => setTimeout(r, 0));
    expect(saved.length).toBe(1);    // save was not dropped
  });

  it('edits save as a draft; the applied plan (header/override) is unchanged until Confirm', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._toggleLock(); el._addSetpoint(); await el._sync(); await el.updateComplete;
    expect(saved[0].type).toBe('timeline_scheduler/save_draft');
    expect(el._schedule.draft).toBeTruthy();
    expect(el.shadowRoot.querySelector('.draft')).toBeTruthy();
    expect(el._appliedDay().length).toBe(1);          // still the original setpoint
    expect(el._activeDay().length).toBe(2);           // the draft has the new one
    await el._confirm(); await el.updateComplete;
    expect(saved[saved.length - 1].type).toBe('timeline_scheduler/confirm_draft');
    expect(el.shadowRoot.querySelector('.draft')).toBeNull();
    expect(el._appliedDay().length).toBe(2);
  });
  it('discard restores the applied plan', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._toggleLock(); el._addSetpoint(); await el._sync();
    await el._discard(); await el.updateComplete;
    expect(saved[saved.length - 1].type).toBe('timeline_scheduler/discard_draft');
    expect(el._activeDay().length).toBe(1);
    expect(el.shadowRoot.querySelector('.draft')).toBeNull();
  });
  it('a schedule loaded with a draft shows it and edits it', async () => {
    const el = document.createElement('timeline-scheduler-card') as any;
    el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
    const draft = { transitions: [{ id: 'd', when: { type: 'time', at: '06:00' }, value: { mode: null, temp: 70 } }], on_mode: 'auto' };
    el.hass = { connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? { ...SCH, draft } : { schedules: [SCH] }) }, states: {} };
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
    expect(el.shadowRoot.querySelector('.draft')).toBeTruthy();
    expect(el._onMode).toBe('auto');
    expect(el._activeDay()[0].value).toEqual({ mode: null, temp: 70 });
    expect(el._appliedDay()[0].value).toEqual({ mode: null, temp: 80 });
  });
  it('"Sync all days" syncs on enable (as a draft), mirrors edits and hides the copy controls', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._toggleLock(); el._day = 'mon'; await el.updateComplete;
    expect(el.shadowRoot.querySelector('.foot select')).toBeTruthy();
    expect(el.shadowRoot.querySelector('.alldays').textContent).toContain('Sync all days');
    el._perDay.tue = [];                       // days differ -> enabling must sync them
    el._setAllDays(true); await el.updateComplete;
    expect(el._perDay.tue.length).toBe(1);
    expect(el._dirty).toBe(true);
    expect(el.shadowRoot.querySelector('.draft')).toBeTruthy();   // Confirm is offered
    expect(el.shadowRoot.querySelector('.foot select')).toBeNull();
    expect([...el.shadowRoot.querySelectorAll('.foot button')].map((b: any) => b.textContent.trim())).toEqual(['＋ Add setpoint']);
    el._addSetpoint(); await el.updateComplete;
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) expect(el._perDay[d].length).toBe(2);
    el._setAllDays(false); await el.updateComplete;
    expect(el.shadowRoot.querySelector('.foot select')).toBeTruthy();
  });
  it('enabling "Sync all days" when the days already match changes nothing', async () => {
    const saved: any[] = []; const el = await mount(saved);
    el._toggleLock(); await el.updateComplete;
    el._setAllDays(true); await el.updateComplete;
    expect(el._dirty).toBe(false);
    expect(el.shadowRoot.querySelector('.draft')).toBeNull();
    expect(el.shadowRoot.querySelector('.status').textContent).not.toContain('Confirm');
  });
});
