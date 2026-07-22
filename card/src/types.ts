export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export interface When { type: 'time' | 'anchor'; at?: string; entity?: string; offset?: string; }
// number = temperature / numeric value; string = a mode ("off"/"auto"/"heat"…) or on/off.
export type SetVal = number | string;
export interface Transition { id: string; when: When; value: SetVal; weekdays?: Weekday[]; }
export interface Schedule {
  id: string; name: string; enabled: boolean;
  target: { entity_id: string }; apply: string;
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
