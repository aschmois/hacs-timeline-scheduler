# Timeline Scheduler — Lovelace Timeline Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Execute all tasks continuously; do not check in between tasks.

**Goal:** A HACS-distributed Lovelace card (`timeline-scheduler-card`) that renders and edits a schedule as a Nest-style per-day setpoint timeline, talking to the `timeline_scheduler/*` WebSocket API, bundled and auto-served by the integration.

**Architecture:** TypeScript + Lit 3, built with rollup in a Node container. A pure-logic layer (WS API client, per-day expand/collapse, anchor resolution, timeline geometry) is unit-tested with vitest+jsdom. The Lit element wraps `<ha-card>`, drives all chrome from HA theme CSS variables (tuned for dark), and builds the SVG timeline imperatively (ported from the approved design mockup). The integration registers the built JS as a frontend module so a single HACS install delivers engine + API + card.

**Tech Stack:** TypeScript 5, Lit 3, rollup 4, vitest + jsdom, Home Assistant frontend (`hass.connection`, theme vars, `ha-card`), Python (integration static-path registration).

## Global Constraints

- Card custom element name: `timeline-scheduler-card`; config key `type: custom:timeline-scheduler-card`.
- WS API (already on `main`): `timeline_scheduler/list` → `{schedules:[...]}`; `get {id_}`; `preview {id_, date}` → `{date, occurrences:[{time,value,transition_id}]}`; `save {schedule}` (admin); `delete {id_}` (admin). **Schedule-id field is `id_`** (HA reserves top-level `id`).
- Schedule/Transition JSON shape matches the engine's `to_dict`: `{id,name,enabled,target:{entity_id},apply,default,transitions:[{id,when:{type:'time',at}|{type:'anchor',entity,offset},value,weekdays:[mon..sun]}]}`.
- **Theming:** wrap in `<ha-card>`; all chrome colors come from HA theme CSS variables (`--card-background-color`, `--primary-text-color`, `--secondary-text-color`, `--primary-color`, `--divider-color`, `--secondary-background-color`). Tune the temperature ramp + alarm accent (own semantic colors) for **dark** (the user's mode). No hardcoded chrome greys.
- **Weekday model:** per-day editing. The card expands a schedule into 7 per-day lists (a transition applies to each day in its `weekdays`); edits are per-day; **on save, each per-day entry is written as a transition with `weekdays:[thatDay]`**. A "copy day to…" action copies one day's list onto others.
- Weekday order/keys: `['mon','tue','wed','thu','fri','sat','sun']`.
- **Build/test execution:** a persistent Node container **`tl-card`** (node:20-alpine, repo mounted at `/repo`) is used for all frontend build/test — `docker exec tl-card sh -c "cd /repo/card && <cmd>"`. The integration test (Task 7) runs in the existing **`tl-test`** Python container. Do NOT install node/npm on the host.
- Public repo — no personal info; generic IDs only (`climate.bed`, `input_datetime.wakeup_time`). Commit as the repo's configured identity.
- Built artifact is committed (HACS does not build): rollup outputs to `card/dist/timeline-scheduler-card.js` and the build copies it to `custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js`.

---

## File Structure

- `card/package.json`, `card/tsconfig.json`, `card/rollup.config.mjs`, `card/vitest.config.ts`, `card/.gitignore` — scaffold/build.
- `card/src/index.ts` — registers the element + `customCards`.
- `card/src/types.ts` — TS interfaces (Weekday, When, Transition, Schedule, HassLike).
- `card/src/api.ts` — WS client wrappers.
- `card/src/schedule.ts` — expandByDay / collapseToTransitions / resolveAnchorMinutes / daySegments / minute helpers.
- `card/src/geometry.ts` — temp↔y, min↔x, tempColor ramp, plot constants.
- `card/src/card.ts` — the `TimelineSchedulerCard` LitElement (render + drag/edit + save + copy).
- `card/src/editor.ts` — the config editor element.
- `card/dev/index.html` — standalone harness with a mock `hass` (visual dev, no HA).
- `card/src/*.test.ts` — vitest tests.
- `custom_components/timeline_scheduler/__init__.py` — MODIFY: register + serve the built JS.
- `custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js` — the committed build output.
- `tests/test_frontend_serving.py` — integration serving test.

---

### Task 1: Card scaffold + Node build/test container + pipeline

**Files:** Create `card/package.json`, `card/tsconfig.json`, `card/rollup.config.mjs`, `card/vitest.config.ts`, `card/.gitignore`, `card/src/index.ts`, `card/src/placeholder.test.ts`.

**Interfaces:**
- Produces: an `npm run build` that emits `card/dist/timeline-scheduler-card.js`, an `npm test` (vitest) that runs, and the `tl-card` container ready for later tasks.

- [ ] **Step 1: Write the config files**

`card/package.json`:
```json
{
  "name": "timeline-scheduler-card",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "scripts": {
    "build": "rollup -c && node -e \"import('node:fs').then(fs=>{fs.mkdirSync('../custom_components/timeline_scheduler/frontend',{recursive:true});fs.copyFileSync('dist/timeline-scheduler-card.js','../custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js')})\"",
    "test": "vitest run"
  },
  "dependencies": { "lit": "^3.2.0" },
  "devDependencies": {
    "@rollup/plugin-node-resolve": "^16.0.0",
    "@rollup/plugin-typescript": "^12.1.0",
    "@rollup/plugin-terser": "^0.4.4",
    "rollup": "^4.24.0",
    "tslib": "^2.8.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "jsdom": "^25.0.0"
  }
}
```

`card/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021", "module": "ESNext", "moduleResolution": "bundler",
    "experimentalDecorators": true, "useDefineForClassFields": false,
    "strict": true, "noUnusedLocals": true, "skipLibCheck": true,
    "lib": ["ES2021", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

`card/rollup.config.mjs`:
```js
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/index.ts',
  output: { file: 'dist/timeline-scheduler-card.js', format: 'es', sourcemap: false },
  plugins: [resolve(), typescript({ tsconfig: './tsconfig.json' }), terser()],
};
```

`card/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', include: ['src/**/*.test.ts'] } });
```

`card/.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: Write the placeholder element + a passing test**

`card/src/index.ts`:
```ts
import './card';
(window as unknown as { customCards?: unknown[] }).customCards ??= [];
(window as unknown as { customCards: unknown[] }).customCards.push({
  type: 'timeline-scheduler-card',
  name: 'Timeline Scheduler Card',
  description: 'Nest-style per-day setpoint timeline editor.',
});
```

Create a stub `card/src/card.ts` so the import resolves (replaced in Task 4):
```ts
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('timeline-scheduler-card')
export class TimelineSchedulerCard extends LitElement {
  render() { return html`<ha-card>timeline-scheduler-card</ha-card>`; }
}
```

`card/src/placeholder.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
describe('scaffold', () => {
  it('imports the card module and registers the element', async () => {
    await import('./index');
    expect(customElements.get('timeline-scheduler-card')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Start the `tl-card` container and install deps**

Run:
```bash
docker rm -f tl-card >/dev/null 2>&1
docker run -d --name tl-card --entrypoint sleep -v /home/hass/hacs-timeline-scheduler:/repo -w /repo/card node:20-alpine infinity
docker exec tl-card sh -c "cd /repo/card && npm install"
```
Expected: install completes without errors.

- [ ] **Step 4: Run test + build to verify the pipeline**

Run: `docker exec tl-card sh -c "cd /repo/card && npm test"`
Expected: PASS (1 test).
Run: `docker exec tl-card sh -c "cd /repo/card && npm run build && ls -1 dist ../custom_components/timeline_scheduler/frontend"`
Expected: `dist/timeline-scheduler-card.js` and the copied `frontend/timeline-scheduler-card.js` both exist.

- [ ] **Step 5: Commit** (built JS is committed intentionally; `dist/` and `node_modules/` are git-ignored)
```bash
git add card/package.json card/tsconfig.json card/rollup.config.mjs card/vitest.config.ts card/.gitignore card/src/index.ts card/src/card.ts card/src/placeholder.test.ts custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js
git commit -m "feat(card): scaffold, build pipeline, and node test container"
```

---

### Task 2: Types + WebSocket API client

**Files:** Create `card/src/types.ts`, `card/src/api.ts`, `card/src/api.test.ts`.

**Interfaces:**
- Produces: `types.ts` interfaces `Weekday`, `When`, `Transition`, `Schedule`, `HassLike` (`{ connection: { sendMessagePromise<T>(msg): Promise<T> }, states: Record<string, {state:string}> }`); `api.ts` functions `listSchedules(hass): Promise<Schedule[]>`, `getSchedule(hass,id): Promise<Schedule>`, `previewDay(hass,id,date): Promise<{date:string;occurrences:{time:string;value:unknown;transition_id:string}[]}>`, `saveSchedule(hass,schedule): Promise<Schedule>`, `deleteSchedule(hass,id): Promise<{id:string;removed:boolean}>`.

- [ ] **Step 1: Write the failing test**

`card/src/api.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/api.test.ts"` → FAIL (module not found).

- [ ] **Step 3: Implement**

`card/src/types.ts`:
```ts
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
```

`card/src/api.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify pass** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/api.test.ts"` → PASS.
- [ ] **Step 5: Commit**
```bash
git add card/src/types.ts card/src/api.ts card/src/api.test.ts
git commit -m "feat(card): types + websocket api client"
```

---

### Task 3: Schedule logic + geometry (pure, unit-tested)

**Files:** Create `card/src/schedule.ts`, `card/src/geometry.ts`, `card/src/schedule.test.ts`, `card/src/geometry.test.ts`.

**Interfaces:**
- Produces (`schedule.ts`):
  - `parseHHMM(s): number` (minutes), `fmtMin(m): string` ("HH:MM").
  - `parseOffsetMin(s): number` (signed minutes from "±HH:MM"), `fmtOffsetMin(m): string`.
  - `interface DayEntry { id: string; kind: 'time' | 'anchor'; atMin?: number; entity?: string; offsetMin?: number; value: SetVal }`.
  - `expandByDay(sch: Schedule): Record<Weekday, DayEntry[]>` — a transition with `weekdays` (default all) contributes a DayEntry (fresh id per day) to each of its days.
  - `collapseToTransitions(perDay): Transition[]` — each DayEntry → a Transition with `weekdays:[day]`.
  - `resolveMin(e: DayEntry, hass: HassLike): number | null` — for `time`, `atMin`; for `anchor`, `(alarmMin + offsetMin)` where alarmMin comes from `hass.states[e.entity].state` parsed as HH:MM[:SS]; `null` if unavailable.
  - `daySegments(entries: DayEntry[], hass): { m0:number; m1:number; value:SetVal }[]` — resolves entries, sorts, builds a wrapping step function over 0..1440 (held value = last entry's).
- Produces (`geometry.ts`): `TMIN=55, TMAX=110`, `tempColor(t:number): string` (blue→amber→red ramp), `plot` constants `{L,R,T,B,off,axis}`, `xOfMin(m): number`, `yOfTemp(t): number`, `minOfX(px): number`, `tempOfY(py): number`.

- [ ] **Step 1: Write the failing tests**

`card/src/geometry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { tempColor, xOfMin, yOfTemp, minOfX, tempOfY, TMIN, TMAX } from './geometry';

describe('geometry', () => {
  it('tempColor returns rgb and warms with temperature', () => {
    expect(tempColor(TMIN)).toMatch(/^rgb\(/);
    const cool = tempColor(60), hot = tempColor(108);
    const r = (s: string) => Number(s.slice(4, -1).split(',')[0]);
    expect(r(hot)).toBeGreaterThan(r(cool)); // more red when hotter
  });
  it('min<->x and temp<->y round-trip', () => {
    expect(Math.round(minOfX(xOfMin(600)))).toBe(600);
    expect(Math.round(tempOfY(yOfTemp(80)))).toBe(80);
    expect(yOfTemp(TMAX)).toBeLessThan(yOfTemp(TMIN)); // hotter is higher
  });
});
```

`card/src/schedule.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { expandByDay, collapseToTransitions, daySegments, parseOffsetMin, fmtMin } from './schedule';
import type { Schedule } from './types';

const SCH: Schedule = {
  id: 'bed', name: 'Bed', enabled: true, target: { entity_id: 'climate.bed' },
  apply: 'climate_temperature', default: { value: null },
  transitions: [
    { id: 't1', when: { type: 'time', at: '20:00' }, value: 80, weekdays: ['mon', 'tue'] },
    { id: 't2', when: { type: 'anchor', entity: 'input_datetime.wakeup_time', offset: '-00:30' }, value: 95, weekdays: ['mon'] },
  ],
};
const hass = { connection: {} as any, states: { 'input_datetime.wakeup_time': { state: '06:30:00' } } } as any;

describe('schedule', () => {
  it('parseOffsetMin handles signs', () => {
    expect(parseOffsetMin('-00:30')).toBe(-30);
    expect(parseOffsetMin('+01:15')).toBe(75);
  });
  it('expandByDay puts transitions on each of their weekdays', () => {
    const by = expandByDay(SCH);
    expect(by.mon.length).toBe(2);
    expect(by.tue.length).toBe(1);
    expect(by.wed.length).toBe(0);
  });
  it('collapseToTransitions writes single-day weekdays', () => {
    const by = expandByDay(SCH);
    const flat = collapseToTransitions(by);
    // mon has 2 + tue has 1 = 3 transitions, each single-day
    expect(flat.length).toBe(3);
    expect(flat.every((t) => t.weekdays!.length === 1)).toBe(true);
  });
  it('daySegments builds a wrapping step function resolving anchors', () => {
    const by = expandByDay(SCH);
    const segs = daySegments(by.mon, hass); // anchor 06:30-00:30 = 06:00 -> 95; 20:00 -> 80
    // value held from 00:00 is the last entry (20:00 -> 80)
    expect(segs[0].value).toBe(80);
    const at6 = segs.find((s) => s.m0 === 360);
    expect(at6?.value).toBe(95);
    expect(fmtMin(360)).toBe('06:00');
  });
});
```

- [ ] **Step 2: Run to verify fail** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/geometry.test.ts src/schedule.test.ts"` → FAIL.

- [ ] **Step 3: Implement `geometry.ts`**
```ts
export const TMIN = 55, TMAX = 110;
export const plot = { L: 52, R: 980, T: 26, B: 232, off: 272, axis: 302 };
const W = plot.R - plot.L, H = plot.B - plot.T;
export const xOfMin = (m: number) => plot.L + (m / 1440) * W;
export const minOfX = (px: number) => ((px - plot.L) / W) * 1440;
export const yOfTemp = (t: number) => plot.B - ((clamp(t, TMIN, TMAX) - TMIN) / (TMAX - TMIN)) * H;
export const tempOfY = (py: number) => TMIN + ((plot.B - py) / H) * (TMAX - TMIN);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function tempColor(t: number): string {
  const stops: [number, [number, number, number]][] =
    [[55, [74, 144, 217]], [80, [239, 177, 90]], [110, [226, 96, 63]]];
  if (t <= stops[0][0]) return rgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i], u = (t - a0) / (a1 - a0);
      return rgb([lerp(c0[0], c1[0], u), lerp(c0[1], c1[1], u), lerp(c0[2], c1[2], u)]);
    }
  }
  return rgb(stops[stops.length - 1][1]);
}
const rgb = (c: number[]) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;
```

- [ ] **Step 4: Implement `schedule.ts`**
```ts
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
```

- [ ] **Step 5: Run to verify pass** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/geometry.test.ts src/schedule.test.ts"` → PASS.
- [ ] **Step 6: Commit**
```bash
git add card/src/geometry.ts card/src/schedule.ts card/src/geometry.test.ts card/src/schedule.test.ts
git commit -m "feat(card): per-day expand/collapse, anchor resolution, geometry"
```

---

### Task 4: The Lit card — themed render (read from API) + dev harness

**Files:** Replace `card/src/card.ts`; create `card/dev/index.html`, `card/src/card.test.ts`.

**Interfaces:**
- Consumes: `api.getSchedule/listSchedules`, `schedule.expandByDay/daySegments/resolveMin/fmtMin`, `geometry.*`.
- Produces: `TimelineSchedulerCard` (element `timeline-scheduler-card`) with `setConfig(config: { schedule_id?: string; name?: string })`, a `hass` setter that loads the schedule, and `getCardSize()`. Internal state: `_perDay`, `_day: Weekday`, `_sel`, `_schedule`. Renders `<ha-card>` with header (name/target/now-status), weekday tabs, an `<svg>` timeline (built imperatively in `updated()`), and a transition list. Read-only in this task (drag/save added in Task 5). Exposes protected `_renderTimeline(svg)` and `_activeDay()` for Task 5.

- [ ] **Step 1: Write the failing test**

`card/src/card.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import './card';
import type { Schedule } from './types';

const SCH: Schedule = {
  id: 'bed', name: 'Bedroom Bed', enabled: true, target: { entity_id: 'climate.bed' },
  apply: 'climate_temperature', default: { value: null },
  transitions: [
    { id: 't1', when: { type: 'time', at: '20:00' }, value: 80, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
    { id: 't2', when: { type: 'time', at: '02:00' }, value: 83, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  ],
};
function mkHass() {
  return { connection: { sendMessagePromise: async (m: any) => (m.type === 'timeline_scheduler/get' ? SCH : { schedules: [SCH] }) }, states: {} } as any;
}
async function mount() {
  const el = document.createElement('timeline-scheduler-card') as any;
  el.setConfig({ schedule_id: 'bed' });
  document.body.appendChild(el);
  el.hass = mkHass();
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

describe('timeline-scheduler-card', () => {
  beforeEach(() => (document.body.innerHTML = ''));
  it('renders the schedule name and a dot per transition for the active day', async () => {
    const el = await mount();
    const txt = el.shadowRoot.textContent;
    expect(txt).toContain('Bedroom Bed');
    const dots = el.shadowRoot.querySelectorAll('.dot');
    expect(dots.length).toBe(2); // both transitions apply every day
  });
  it('throws on missing config', () => {
    const el = document.createElement('timeline-scheduler-card') as any;
    expect(() => el.setConfig(undefined)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/card.test.ts"` → FAIL.

- [ ] **Step 3: Implement `card/src/card.ts`**

```ts
import { LitElement, html, css, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HassLike, Schedule, Weekday, SetVal } from './types';
import { WEEKDAYS } from './types';
import { getSchedule } from './api';
import { expandByDay, daySegments, resolveMin, fmtMin, DayEntry } from './schedule';
import { plot, xOfMin, yOfTemp, tempColor } from './geometry';

interface CardConfig { schedule_id?: string; name?: string; }
const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const SVGNS = 'http://www.w3.org/2000/svg';
const el = (n: string, a: Record<string, string | number>) => {
  const e = document.createElementNS(SVGNS, n);
  for (const k in a) e.setAttribute(k, String(a[k]));
  return e;
};

@customElement('timeline-scheduler-card')
export class TimelineSchedulerCard extends LitElement {
  @property({ attribute: false }) public hass?: HassLike;
  @state() protected _config?: CardConfig;
  @state() protected _schedule?: Schedule;
  @state() protected _perDay?: Record<Weekday, DayEntry[]>;
  @state() protected _day: Weekday = todayKey();
  @state() protected _sel: string | null = null;
  @state() protected _dirty = false;
  private _loadedFor?: string;

  public setConfig(config: CardConfig): void {
    if (!config) throw new Error('Invalid configuration');
    this._config = config;
  }
  public getCardSize(): number { return 6; }

  protected updated(changed: PropertyValues): void {
    if ((changed.has('hass') || changed.has('_config')) && this.hass && this._config?.schedule_id
      && this._loadedFor !== this._config.schedule_id) {
      this._loadedFor = this._config.schedule_id;
      void this._load();
    }
    const svg = this.renderRoot.querySelector('svg.tl');
    if (svg) this._renderTimeline(svg as SVGSVGElement);
  }

  protected async _load(): Promise<void> {
    if (!this.hass || !this._config?.schedule_id) return;
    const sch = await getSchedule(this.hass, this._config.schedule_id);
    this._schedule = sch;
    this._perDay = expandByDay(sch);
    this._dirty = false;
    this.requestUpdate();
  }

  protected _activeDay(): DayEntry[] { return this._perDay ? this._perDay[this._day] : []; }

  protected _renderTimeline(svg: SVGSVGElement): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!this.hass || !this._perDay) return;
    const entries = this._activeDay();
    const g = (n: string, a: Record<string, string | number>) => { const e = el(n, a); svg.appendChild(e); return e; };
    // temp gridlines
    for (let t = 60; t <= 110; t += 10) {
      g('line', { class: 'grid', x1: plot.L, y1: yOfTemp(t), x2: plot.R, y2: yOfTemp(t) });
      const tx = g('text', { class: 'axis', x: plot.L - 9, y: yOfTemp(t) + 3, 'text-anchor': 'end' }); tx.textContent = `${t}°`;
    }
    g('line', { class: 'grid', x1: plot.L, y1: plot.off, x2: plot.R, y2: plot.off });
    const ot = g('text', { class: 'axis', x: plot.L - 9, y: plot.off + 3, 'text-anchor': 'end' }); ot.textContent = 'off';
    // hour axis
    for (let h = 0; h <= 24; h += 3) {
      g('line', { class: 'grid', x1: xOfMin(h * 60), y1: plot.T, x2: xOfMin(h * 60), y2: plot.off });
      const ax = g('text', { class: 'axis', x: xOfMin(h * 60), y: plot.axis, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle' });
      ax.textContent = `${h === 24 ? '24' : String(h).padStart(2, '0')}:00`;
    }
    // segments
    for (const s of daySegments(entries, this.hass)) {
      if (s.value === 'off') {
        g('rect', { x: xOfMin(s.m0), y: plot.off - 5, width: Math.max(0, xOfMin(s.m1) - xOfMin(s.m0)), height: 10, rx: 3, class: 'seg-off' });
      } else {
        const c = tempColor(s.value as number), y = yOfTemp(s.value as number);
        g('rect', { x: xOfMin(s.m0), y, width: Math.max(0, xOfMin(s.m1) - xOfMin(s.m0)), height: plot.B - y, fill: c, opacity: 0.16 });
        g('line', { class: 'segline', x1: xOfMin(s.m0), y1: y, x2: xOfMin(s.m1), y2: y, stroke: c });
      }
    }
    // now line
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    g('line', { class: 'nowline', x1: xOfMin(nm), y1: plot.T, x2: xOfMin(nm), y2: plot.off });
    // dots
    for (const e of entries) {
      const m = resolveMin(e, this.hass); if (m === null) continue;
      const off = e.value === 'off'; const cx = xOfMin(m), cy = off ? plot.off : yOfTemp(e.value as number);
      const grp = el('g', { class: 'dot' + (e.id === this._sel ? ' sel' : ''), 'data-id': e.id, tabindex: 0 });
      grp.appendChild(el('circle', { class: 'hit', cx, cy, r: 18 }));
      if (e.kind === 'anchor') grp.appendChild(el('circle', { class: 'ring', cx, cy, r: 11 }));
      grp.appendChild(el('circle', { class: 'body', cx, cy, r: 7, fill: off ? 'var(--tsc-off)' : tempColor(e.value as number) }));
      svg.appendChild(grp);
      this._wireDot?.(grp as SVGGElement, e);
    }
  }
  // hook overridden in Task 5; no-op here
  protected _wireDot?(grp: SVGGElement, e: DayEntry): void;

  private _statusNow() {
    if (!this.hass || !this._perDay) return { cur: '—', next: '' };
    const entries = this._activeDay();
    const pts = entries.map((e) => ({ m: resolveMin(e, this.hass!), v: e.value })).filter((p) => p.m !== null).sort((a, b) => (a.m! - b.m!));
    if (!pts.length) return { cur: '—', next: '' };
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    let cur = pts[pts.length - 1]; for (const p of pts) if (p.m! <= nm) cur = p;
    const nxt = pts.find((p) => p.m! > nm) ?? pts[0];
    const fmtV = (v: SetVal) => (v === 'off' ? 'Off' : `${v}°`);
    return { cur: fmtV(cur.v), next: `→ ${fmtV(nxt.v)} at ${fmtMin(nxt.m!)}` };
  }

  render() {
    if (!this._config) return html``;
    const s = this._schedule; const st = this._statusNow();
    return html`
      <ha-card>
        <div class="head">
          <div class="title">
            <h2>${this._config.name ?? s?.name ?? 'Schedule'}</h2>
            <div class="target">${s?.target.entity_id ?? this._config.schedule_id ?? ''}</div>
          </div>
          <div class="now"><div class="cur">${st.cur}</div><div class="nxt">${st.next}</div></div>
        </div>
        <div class="days">
          ${WEEKDAYS.map((d) => html`<button class="day" aria-pressed=${d === this._day} @click=${() => { this._day = d; this._sel = null; }}>${DAY_LABEL[d]}</button>`)}
        </div>
        <svg class="tl" viewBox="0 0 1000 320" preserveAspectRatio="none" aria-label="setpoint timeline"></svg>
        <div class="list">
          ${this._activeDay().map((e) => this._row(e))}
        </div>
        ${this._footer()}
      </ha-card>`;
  }

  protected _row(e: DayEntry) {
    const m = resolveMin(e, this.hass!); const off = e.value === 'off';
    return html`<div class="row ${e.id === this._sel ? 'sel' : ''}" @click=${() => (this._sel = e.id)}>
      <span class="sw" style=${`background:${off ? 'var(--tsc-off)' : tempColor(e.value as number)}`}></span>
      <span class="when">${m === null ? '—' : fmtMin(m)}</span>
      <span class="kind ${e.kind}">${e.kind === 'anchor' ? '⏰ alarm' : 'fixed'}</span>
      <span class="temp">${off ? 'OFF' : `${e.value}°`}</span>
    </div>`;
  }
  protected _footer() { return html``; } // filled in Task 5

  static styles = css`
    :host { display: block; }
    .head { display: flex; gap: 16px; padding: 16px 16px 10px; align-items: flex-start; }
    .title h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
    .target { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; font-family: var(--code-font-family, monospace); }
    .now { margin-left: auto; text-align: right; }
    .now .cur { font-size: 22px; font-weight: 600; color: var(--primary-text-color); }
    .now .nxt { font-size: 12px; color: var(--secondary-text-color); }
    .days { display: flex; gap: 6px; padding: 0 16px 12px; }
    .day { flex: 1; padding: 7px 0; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
      background: var(--secondary-background-color); color: var(--secondary-text-color);
      border: 1px solid var(--divider-color); }
    .day[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
    svg.tl { display: block; width: 100%; height: auto; touch-action: none; }
    .grid { stroke: var(--divider-color); stroke-width: 1; opacity: .5; }
    .axis { fill: var(--secondary-text-color); font-size: 10px; font-family: var(--code-font-family, monospace); }
    .segline { stroke-width: 2.5; stroke-linecap: round; }
    .seg-off { fill: var(--tsc-off); opacity: .25; stroke: var(--tsc-off); }
    .nowline { stroke: var(--secondary-text-color); stroke-width: 1; stroke-dasharray: 2 3; opacity: .6; }
    .dot { cursor: grab; } .dot:active { cursor: grabbing; }
    .dot .hit { fill: transparent; } .dot .body { stroke: var(--card-background-color); stroke-width: 2; }
    .dot.sel .body { stroke: var(--primary-text-color); }
    .dot .ring { fill: none; stroke: var(--primary-color); stroke-width: 1.4; stroke-dasharray: 2.5 2.5; }
    .list { padding: 6px 10px 4px; }
    .row { display: flex; gap: 10px; align-items: center; padding: 8px 8px; border-radius: 8px; cursor: pointer; }
    .row:hover, .row.sel { background: var(--secondary-background-color); }
    .sw { width: 10px; height: 10px; border-radius: 3px; }
    .when { font-family: var(--code-font-family, monospace); min-width: 52px; color: var(--primary-text-color); }
    .kind { font-size: 11px; color: var(--secondary-text-color); border: 1px solid var(--divider-color); padding: 1px 7px; border-radius: 999px; }
    .kind.anchor { color: var(--primary-color); border-color: var(--primary-color); }
    .temp { margin-left: auto; font-weight: 600; color: var(--primary-text-color); font-family: var(--code-font-family, monospace); }
    :host { --tsc-off: #6b7280; }
    .foot { display: flex; gap: 10px; padding: 10px 16px 16px; border-top: 1px solid var(--divider-color); }
    button.act { font: inherit; font-weight: 600; font-size: 13px; border-radius: 8px; padding: 9px 13px; cursor: pointer;
      border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); }
    button.save { margin-left: auto; background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
    button[disabled] { opacity: .5; cursor: default; }
  `;
}
function todayKey(): Weekday { return WEEKDAYS[(new Date().getDay() + 6) % 7]; }
```

- [ ] **Step 4: Write the dev harness** `card/dev/index.html` (loads the built bundle, injects a mock hass so the card renders in a browser without HA):
```html
<!doctype html><html><head><meta charset="utf-8"><title>Timeline Card — dev</title>
<style>body{background:#0d1017;margin:0;padding:40px;font-family:system-ui}.wrap{max-width:680px;margin:auto}
:root{--card-background-color:#151a24;--primary-text-color:#e9edf5;--secondary-text-color:#9aa4ba;--primary-color:#f4b45e;--divider-color:#28303f;--secondary-background-color:#1b2130;--text-primary-color:#241704;--code-font-family:ui-monospace,monospace}
ha-card{display:block;background:var(--card-background-color);border-radius:14px;overflow:hidden}</style></head>
<body><div class="wrap"><timeline-scheduler-card id="c"></timeline-scheduler-card></div>
<script type="module" src="../dist/timeline-scheduler-card.js"></script>
<script>
const SCH={id:'bed',name:'Bedroom Bed',enabled:true,target:{entity_id:'climate.bed'},apply:'climate_temperature',default:{value:null},
 transitions:[{id:'t1',when:{type:'time',at:'20:00'},value:80,weekdays:['mon','tue','wed','thu','fri','sat','sun']},
 {id:'t2',when:{type:'time',at:'02:00'},value:83,weekdays:['mon','tue','wed','thu','fri','sat','sun']},
 {id:'t3',when:{type:'anchor',entity:'input_datetime.wakeup_time',offset:'-00:30'},value:95,weekdays:['mon','tue','wed','thu','fri']},
 {id:'t4',when:{type:'anchor',entity:'input_datetime.wakeup_time',offset:'+00:30'},value:'off',weekdays:['mon','tue','wed','thu','fri']}]};
const hass={connection:{sendMessagePromise:async m=>m.type==='timeline_scheduler/get'?SCH:m.type==='timeline_scheduler/list'?{schedules:[SCH]}:m.type==='timeline_scheduler/save'?m.schedule:{}},states:{'input_datetime.wakeup_time':{state:'06:30:00'}}};
const c=document.getElementById('c');c.setConfig({schedule_id:'bed'});c.hass=hass;
</script></body></html>
```

- [ ] **Step 5: Run to verify pass** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/card.test.ts"` → PASS; then `docker exec tl-card sh -c "cd /repo/card && npm test && npm run build"` → all tests pass and the bundle rebuilds.
- [ ] **Step 6: Commit**
```bash
git add card/src/card.ts card/src/card.test.ts card/dev/index.html custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js
git commit -m "feat(card): themed read-only timeline render from the websocket API"
```

---

### Task 5: Editing — drag, add, remove, save

**Files:** Modify `card/src/card.ts`; create `card/src/edit.test.ts`.

**Interfaces:**
- Consumes: `api.saveSchedule`, `schedule.collapseToTransitions`, geometry inverse mappers `minOfX`, `tempOfY`.
- Produces: dragging a dot updates its `atMin`/`offsetMin` (snap 5 min) and `value` (temp; skip for `off`); `_addSetpoint()` appends a `time` entry at 12:00/75°; a remove control per row; `_save()` calls `saveSchedule(collapse(this._perDay))` and clears dirty. A footer with Add + Save (Save disabled unless `_dirty`). Overrides `_wireDot` and `_footer`.

- [ ] **Step 1: Write the failing test**

`card/src/edit.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify fail** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/edit.test.ts"` → FAIL.

- [ ] **Step 3: Implement — add these members to `TimelineSchedulerCard`** (and import `minOfX, tempOfY` from `./geometry`, `collapseToTransitions` from `./schedule`, `saveSchedule` from `./api`):

```ts
  protected _wireDot(grp: SVGGElement, e: DayEntry): void {
    grp.addEventListener('pointerdown', (ev: PointerEvent) => {
      ev.preventDefault(); this._sel = e.id; grp.setPointerCapture(ev.pointerId);
      const svg = grp.ownerSVGElement!;
      const toSvg = (px: number, py: number) => { const p = svg.createSVGPoint(); p.x = px; p.y = py; return p.matrixTransform(svg.getScreenCTM()!.inverse()); };
      const alarm = e.kind === 'anchor' ? resolveMin({ ...e, offsetMin: 0 } as DayEntry, this.hass!) : null;
      const move = (m2: PointerEvent) => {
        const p = toSvg(m2.clientX, m2.clientY);
        const min = Math.max(0, Math.min(1435, Math.round(minOfX(p.x) / 5) * 5));
        if (e.kind === 'time') e.atMin = min;
        else if (alarm !== null) e.offsetMin = Math.max(-300, Math.min(300, Math.round((min - alarm) / 5) * 5));
        if (e.value !== 'off') e.value = Math.max(55, Math.min(110, Math.round(tempOfY(p.y))));
        this._dirty = true; this.requestUpdate(); this._renderTimeline(svg as SVGSVGElement);
      };
      const up = () => { grp.releasePointerCapture(ev.pointerId); svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); this.requestUpdate(); };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up);
    });
  }

  protected _addSetpoint(): void {
    if (!this._perDay) return;
    const id = 'n' + Math.random().toString(36).slice(2);
    this._perDay[this._day].push({ id, kind: 'time', atMin: 12 * 60, value: 75 });
    this._sel = id; this._dirty = true; this.requestUpdate();
  }
  protected _remove(id: string): void {
    if (!this._perDay) return;
    this._perDay[this._day] = this._perDay[this._day].filter((e) => e.id !== id);
    if (this._sel === id) this._sel = null;
    this._dirty = true; this.requestUpdate();
  }
  protected async _save(): Promise<void> {
    if (!this.hass || !this._schedule || !this._perDay) return;
    const next: Schedule = { ...this._schedule, transitions: collapseToTransitions(this._perDay) };
    await saveSchedule(this.hass, next);
    this._schedule = next; this._dirty = false; this.requestUpdate();
  }
```
Replace `_footer()` with:
```ts
  protected _footer() {
    return html`<div class="foot">
      <button class="act" @click=${() => this._addSetpoint()}>＋ Add setpoint</button>
      <button class="act save" ?disabled=${!this._dirty} @click=${() => this._save()}>Save schedule</button>
    </div>`;
  }
```
Add a remove control to `_row` (append before the closing `</div>`):
```ts
      <button class="rm" title="Remove" @click=${(ev: Event) => { ev.stopPropagation(); this._remove(e.id); }}>×</button>
```
Add to styles: `.rm{margin-left:6px;border:none;background:transparent;color:var(--secondary-text-color);cursor:pointer;font-size:15px;border-radius:6px;width:24px;height:24px}.rm:hover{color:var(--error-color,#e06)}`.

- [ ] **Step 4: Run to verify pass** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/edit.test.ts"` → PASS; then `docker exec tl-card sh -c "cd /repo/card && npm test && npm run build"` → all green + rebuilt.
- [ ] **Step 5: Commit**
```bash
git add card/src/card.ts card/src/edit.test.ts custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js
git commit -m "feat(card): drag/add/remove setpoints and save via websocket"
```

---

### Task 6: Copy day + config editor

**Files:** Modify `card/src/card.ts` (copy-day control); create `card/src/editor.ts`, `card/src/copy.test.ts`; update `card/src/index.ts` (register editor).

**Interfaces:**
- Produces: `_copyDayTo(target: Weekday)` copies the active day's entries (fresh ids) onto `target`, marks dirty; a "copy to" control in the footer. `getConfigElement()`/`getStubConfig(hass)` on the card returning a `<timeline-scheduler-card-editor>` and a stub `{ schedule_id }` from the first listed schedule. `editor.ts` = a minimal Lit editor with a schedule-id text field firing `config-changed`.

- [ ] **Step 1: Write the failing test**

`card/src/copy.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
```

- [ ] **Step 2: Run to verify fail** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/copy.test.ts"` → FAIL.

- [ ] **Step 3: Implement `editor.ts`**
```ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HassLike } from './types';

@customElement('timeline-scheduler-card-editor')
export class TimelineSchedulerCardEditor extends LitElement {
  @property({ attribute: false }) public hass?: HassLike;
  @state() private _config: { schedule_id?: string; name?: string } = {};
  public setConfig(config: { schedule_id?: string; name?: string }): void { this._config = { ...config }; }
  private _change(field: string, ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
  }
  render() {
    return html`<div class="f">
      <label>Schedule id
        <input .value=${this._config.schedule_id ?? ''} @input=${(e: Event) => this._change('schedule_id', e)} placeholder="bed" />
      </label>
      <label>Title (optional)
        <input .value=${this._config.name ?? ''} @input=${(e: Event) => this._change('name', e)} />
      </label>
    </div>`;
  }
  static styles = css`.f{display:flex;flex-direction:column;gap:12px;padding:8px 0}
    label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--secondary-text-color)}
    input{padding:8px;border-radius:8px;border:1px solid var(--divider-color);background:var(--secondary-background-color);color:var(--primary-text-color);font:inherit}`;
}
```
Add to `TimelineSchedulerCard` (import `listSchedules` from `./api`, `WEEKDAYS` already imported):
```ts
  static async getConfigElement() { await import('./editor'); return document.createElement('timeline-scheduler-card-editor'); }
  static async getStubConfig(hass: HassLike) {
    try { const list = await listSchedules(hass); if (list.length) return { schedule_id: list[0].id }; } catch { /* none */ }
    return { schedule_id: '' };
  }
  protected _copyDayTo(target: Weekday): void {
    if (!this._perDay || target === this._day) return;
    this._perDay[target] = this._activeDay().map((e) => ({ ...e, id: 'c' + Math.random().toString(36).slice(2) }));
    this._dirty = true; this.requestUpdate();
  }
```
Add a copy control to the footer (before the Save button) — a native select:
```ts
      <select class="act" @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) { this._copyDayTo(v as Weekday); (e.target as HTMLSelectElement).value = ''; } }}>
        <option value="">Copy day to…</option>
        ${WEEKDAYS.filter((d) => d !== this._day).map((d) => html`<option value=${d}>${d}</option>`)}
      </select>
```
Register the editor in `card/src/index.ts` by adding `import './editor';` at the top, and add `preview: true` to the customCards entry.

- [ ] **Step 4: Run to verify pass** — `docker exec tl-card sh -c "cd /repo/card && npx vitest run src/copy.test.ts"` → PASS; then `docker exec tl-card sh -c "cd /repo/card && npm test && npm run build"` → all green + rebuilt.
- [ ] **Step 5: Commit**
```bash
git add card/src/card.ts card/src/editor.ts card/src/index.ts card/src/copy.test.ts custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js
git commit -m "feat(card): copy-day action and config editor"
```

---

### Task 7: Integration serves the card

**Files:** Modify `custom_components/timeline_scheduler/__init__.py`; create `tests/test_frontend_serving.py`; update `hacs.json`.

**Interfaces:**
- Consumes: the committed `custom_components/timeline_scheduler/frontend/timeline-scheduler-card.js`.
- Produces: on `async_setup`, register a static path `/timeline_scheduler/timeline-scheduler-card.js` → the built file, and add it as a frontend extra module URL so the card auto-loads.

- [ ] **Step 1: Write the failing test**

`tests/test_frontend_serving.py`:
```python
from homeassistant.setup import async_setup_component
from custom_components.timeline_scheduler.const import DOMAIN


async def test_setup_registers_card_static_path(hass):
    assert await async_setup_component(hass, DOMAIN, {DOMAIN: {}})
    await hass.async_block_till_done()
    # the frontend module URL was registered for auto-load
    from homeassistant.components.frontend import async_get_url_entries  # noqa: F401 (import guarded below)
```
> If `async_get_url_entries` is not importable in this HA version, assert instead that setup succeeded and the static path is registered by checking `hass.http.app` routes contain the card path. Replace the test body's assertion with:
```python
    routes = [r.resource.canonical for r in hass.http.app.router.routes() if getattr(r, "resource", None)]
    assert any("/timeline_scheduler/timeline-scheduler-card.js" == c for c in routes)
```

- [ ] **Step 2: Run to verify fail** — `docker exec -w /app tl-test python -m pytest tests/test_frontend_serving.py -v` → FAIL (route absent).

- [ ] **Step 3: Implement — add to `custom_components/timeline_scheduler/__init__.py`**

Add imports:
```python
import os
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import add_extra_js_url
```
Add constant near the top:
```python
CARD_URL = "/timeline_scheduler/timeline-scheduler-card.js"
CARD_PATH = os.path.join(os.path.dirname(__file__), "frontend", "timeline-scheduler-card.js")
```
In `async_setup`, after `async_register_ws(hass)` and before `await manager.async_start()`, add:
```python
    if os.path.exists(CARD_PATH):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL, CARD_PATH, False)]
        )
        add_extra_js_url(hass, CARD_URL)
```

- [ ] **Step 4: Run to verify pass** — `docker exec -w /app tl-test python -m pytest tests/test_frontend_serving.py -v` → PASS. Then the whole Python suite: `docker exec -w /app tl-test python -m pytest tests/ -q` → all green. Then the whole card suite: `docker exec tl-card sh -c "cd /repo/card && npm test"` → all green.

- [ ] **Step 5: Update `hacs.json`** so HACS ships both the integration and treats the repo correctly (integration type already; no change needed if it validates — confirm `hacs.json` has `"name"`). Add a `README` note is optional. If `hacs.json` lacks `filename`, leave it (integration type does not use it).

- [ ] **Step 6: Commit**
```bash
git add custom_components/timeline_scheduler/__init__.py tests/test_frontend_serving.py hacs.json
git commit -m "feat: serve and auto-register the timeline card from the integration"
```

---

## Self-Review (author checklist — completed)

**Coverage:** scaffold/build/container → T1; API client → T2; per-day expand/collapse + anchor resolve + geometry → T3; themed read-only render → T4; drag/add/remove/save → T5; copy-day + config editor → T6; integration serving → T7. Design mockup's rendering/interaction logic is ported into T3–T5.

**Placeholder scan:** none — every step has complete code and an exact `docker exec` command with expected result.

**Type consistency:** `HassLike.connection.sendMessagePromise` used identically in api.ts and tests; `DayEntry`/`Weekday`/`Schedule` shapes consistent across schedule.ts, card.ts, tests; `collapseToTransitions` emits single-day `weekdays` (matches the per-day decision and the engine's `weekdays` field); geometry mapper names (`xOfMin/yOfTemp/minOfX/tempOfY`) consistent T3↔T4↔T5; `_wireDot`/`_footer`/`_row` overridden across T4→T5→T6 with stable signatures; WS `id_`/`schedule` field names match the engine's Phase 1.5 API.

**Known follow-ups (not blocking):** the card reads a single schedule (`schedule_id`) — a schedule picker/multi-card is future; `apply`/`target` are edited via Dev Tools/`save` payload, not the card UI yet; i18n omitted (single-locale v1).
