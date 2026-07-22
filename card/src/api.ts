import type { HassLike, Schedule } from './types';

export const listSchedules = (hass: HassLike): Promise<Schedule[]> =>
  hass.connection.sendMessagePromise<{ schedules: Schedule[] }>({ type: 'timeline_scheduler/list' })
    .then((r) => r.schedules);

export const getSchedule = (hass: HassLike, id: string): Promise<Schedule> =>
  hass.connection.sendMessagePromise<Schedule>({ type: 'timeline_scheduler/get', id_: id });

export interface PreviewResult { date: string; occurrences: { time: string; value: unknown; transition_id: string }[]; }
export const previewDay = (hass: HassLike, id: string, date: string): Promise<PreviewResult> =>
  hass.connection.sendMessagePromise<PreviewResult>({ type: 'timeline_scheduler/preview', id_: id, date });

export const saveSchedule = (hass: HassLike, schedule: Schedule): Promise<Schedule> =>
  hass.connection.sendMessagePromise<Schedule>({ type: 'timeline_scheduler/save', schedule });

export const deleteSchedule = (hass: HassLike, id: string): Promise<{ id: string; removed: boolean }> =>
  hass.connection.sendMessagePromise({ type: 'timeline_scheduler/delete', id_: id });

export const setOverride = (hass: HassLike, id: string, value: number | string): Promise<unknown> =>
  hass.connection.sendMessagePromise({ type: 'timeline_scheduler/override', id_: id, value });

export const clearOverride = (hass: HassLike, id: string): Promise<unknown> =>
  hass.connection.sendMessagePromise({ type: 'timeline_scheduler/clear_override', id_: id });
