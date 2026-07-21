import type { HassLike, Schedule, Transition, Weekday, SetVal } from './types';
import { WEEKDAYS } from './types';

const pad = (n: number) => String(n).padStart(2, '0');
export const fmtMin = (m: number) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
export function parseHHMM(s: string): number { const [h, mi] = s.split(':'); return Number(h) * 60 + Number(mi); }
export function parseOffsetMin(s: string): number {
  let sign = 1, v = s.trim();
  if (v[0] === '+' || v[0] === '-') { sign = v[0] === '-' ? -1 : 1; v = v.slice(1); }
  const [h, mi] = v.split(':'); return sign * (Number(h) * 60 + Number(mi));
}
export const fmtOffsetMin = (m: number) => `${m < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;

export interface DayEntry { id: string; kind: 'time' | 'anchor'; atMin?: number; entity?: string; offsetMin?: number; value: SetVal; }

let _uid = 0;
const uid = () => `d${Date.now().toString(36)}${(_uid++).toString(36)}`;

export function expandByDay(sch: Schedule): Record<Weekday, DayEntry[]> {
  const by = Object.fromEntries(WEEKDAYS.map((d) => [d, [] as DayEntry[]])) as Record<Weekday, DayEntry[]>;
  for (const t of sch.transitions) {
    const days = (t.weekdays && t.weekdays.length ? t.weekdays : WEEKDAYS);
    for (const d of days) {
      by[d].push(t.when.type === 'time'
        ? { id: uid(), kind: 'time', atMin: parseHHMM(t.when.at ?? '00:00'), value: t.value }
        : { id: uid(), kind: 'anchor', entity: t.when.entity, offsetMin: parseOffsetMin(t.when.offset ?? '+00:00'), value: t.value });
    }
  }
  return by;
}

export function collapseToTransitions(by: Record<Weekday, DayEntry[]>): Transition[] {
  const out: Transition[] = [];
  for (const d of WEEKDAYS) for (const e of by[d]) {
    out.push({
      id: e.id, value: e.value, weekdays: [d],
      when: e.kind === 'time'
        ? { type: 'time', at: fmtMin(e.atMin ?? 0) }
        : { type: 'anchor', entity: e.entity, offset: fmtOffsetMin(e.offsetMin ?? 0) },
    });
  }
  return out;
}

export function resolveMin(e: DayEntry, hass: HassLike): number | null {
  if (e.kind === 'time') return e.atMin ?? null;
  const st = e.entity ? hass.states[e.entity] : undefined;
  if (!st || st.state === 'unknown' || st.state === 'unavailable' || st.state === '') return null;
  const parts = st.state.split(':'); if (parts.length < 2) return null;
  const alarm = Number(parts[0]) * 60 + Number(parts[1]);
  return (((alarm + (e.offsetMin ?? 0)) % 1440) + 1440) % 1440;
}

export function daySegments(entries: DayEntry[], hass: HassLike): { m0: number; m1: number; value: SetVal }[] {
  const pts = entries.map((e) => ({ min: resolveMin(e, hass), value: e.value }))
    .filter((p): p is { min: number; value: SetVal } => p.min !== null)
    .sort((a, b) => a.min - b.min);
  if (!pts.length) return [];
  const segs: { m0: number; m1: number; value: SetVal }[] = [];
  let prev = 0, val: SetVal = pts[pts.length - 1].value;
  for (const p of pts) { if (p.min > prev) segs.push({ m0: prev, m1: p.min, value: val }); val = p.value; prev = p.min; }
  if (prev < 1440) segs.push({ m0: prev, m1: 1440, value: val });
  return segs;
}
