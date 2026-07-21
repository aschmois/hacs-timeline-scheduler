import { describe, it, expect, vi } from 'vitest';
import { listSchedules, previewDay, saveSchedule } from './api';

function mockHass(handler: (msg: any) => any) {
  return { connection: { sendMessagePromise: vi.fn(async (m: any) => handler(m)) }, states: {} } as any;
}

describe('api', () => {
  it('listSchedules unwraps the schedules array', async () => {
    const hass = mockHass(() => ({ schedules: [{ id: 'bed' }] }));
    expect(await listSchedules(hass)).toEqual([{ id: 'bed' }]);
    expect(hass.connection.sendMessagePromise).toHaveBeenCalledWith({ type: 'timeline_scheduler/list' });
  });
  it('previewDay sends id_ and date', async () => {
    const hass = mockHass((m) => ({ date: m.date, occurrences: [] }));
    await previewDay(hass, 'bed', '2026-01-05');
    expect(hass.connection.sendMessagePromise).toHaveBeenCalledWith(
      { type: 'timeline_scheduler/preview', id_: 'bed', date: '2026-01-05' });
  });
  it('saveSchedule sends the schedule under "schedule"', async () => {
    const hass = mockHass((m) => m.schedule);
    const sch = { id: 'x' } as any;
    expect(await saveSchedule(hass, sch)).toBe(sch);
    expect(hass.connection.sendMessagePromise).toHaveBeenCalledWith(
      { type: 'timeline_scheduler/save', schedule: sch });
  });
});
