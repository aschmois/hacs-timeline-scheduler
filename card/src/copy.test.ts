import { describe, it, expect, beforeEach } from 'vitest';
import './card';
import type { Schedule } from './types';
const SCH: Schedule = { id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' }, apply: 'climate_temperature',
  default: { value: null }, transitions: [{ id: 't1', when: { type: 'time', at: '20:00' }, value: 80, weekdays: ['mon'] }] };
async function mount() {
  const el = document.createElement('timeline-scheduler-card') as any;
  el.setConfig({ schedule_id: 'bed' }); document.body.appendChild(el);
  el.hass = { connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }) }, states: {} };
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); await el.updateComplete; }
  return el;
}
describe('copy day + editor', () => {
  beforeEach(() => (document.body.innerHTML = ''));
  it('copies the active day onto another day with fresh ids', async () => {
    const el = await mount(); el._day = 'mon'; await el.updateComplete;
    el._copyDayTo('wed'); await el.updateComplete;
    expect(el._perDay.wed.length).toBe(1);
    expect(el._perDay.wed[0].id).not.toBe(el._perDay.mon[0].id);
    expect(el._dirty).toBe(true);
  });
  it('exposes a config element and stub config', async () => {
    const CardCls = customElements.get('timeline-scheduler-card') as any;
    const stub = await CardCls.getStubConfig({ connection: { sendMessagePromise: async () => ({ schedules: [SCH] }) } });
    expect(stub.schedule_id).toBe('bed');
    expect(await CardCls.getConfigElement()).toBeTruthy();
  });
});
