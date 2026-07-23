export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export interface When { type: 'time' | 'anchor'; at?: string; entity?: string; offset?: string; }
// A per-apply value object (matches the stored/wire JSON):
//   climate_temperature -> { mode: string|null, temp: number|null }
//   switch_onoff        -> { state: 'on'|'off' }
//   number_set          -> { value: number }
export interface SetVal { mode?: string | null; temp?: number | null; state?: string; value?: number; }
export interface Transition { id: string; when: When; value: SetVal; weekdays?: Weekday[]; }
export interface Schedule {
  id: string; name: string; enabled: boolean;
  target: { entity_id: string }; apply: string;
  // Climate: hvac mode used to turn on for a temperature-only setpoint.
  on_mode?: string | null;
  default?: { value: SetVal | null } | null; transitions: Transition[];
}
export interface HassEntity { state: string; attributes?: Record<string, any>; }
export interface HassDevice { id: string; identifiers: [string, string][]; }
export interface HassLike {
  connection: { sendMessagePromise<T = any>(msg: Record<string, unknown>): Promise<T> };
  states: Record<string, HassEntity | undefined>;
  config?: { unit_system?: { temperature?: string } };
  locale?: { time_format?: string };
  devices?: Record<string, HassDevice>;
}
export type TempUnit = 'C' | 'F';
export interface CardConfig { schedule_id?: string; name?: string; unit?: 'auto' | 'C' | 'F'; }
