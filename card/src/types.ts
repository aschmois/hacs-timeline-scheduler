export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export interface When { type: 'time' | 'anchor'; at?: string; entity?: string; offset?: string; }
export type SetVal = number | string; // number °, or "off"
export interface Transition { id: string; when: When; value: SetVal; weekdays?: Weekday[]; }
export interface Schedule {
  id: string; name: string; enabled: boolean;
  target: { entity_id: string }; apply: string;
  default?: { value: SetVal | null } | null; transitions: Transition[];
}
export interface HassLike {
  connection: { sendMessagePromise<T = any>(msg: Record<string, unknown>): Promise<T> };
  states: Record<string, { state: string } | undefined>;
}
