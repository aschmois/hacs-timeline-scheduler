import { LitElement, html, css, PropertyValues, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HassLike, Schedule, Weekday, SetVal, TempUnit, CardConfig } from './types';
import { WEEKDAYS } from './types';
import { getSchedule, saveSchedule, listSchedules, setOverride, clearOverride, fetchHistory } from './api';
import {
  expandByDay, daySegments, resolveMin, fmtMin, fmtClock, parseHHMM,
  vTemp, vMode, vOn, vNumber, mkClimate, mkSwitch, mkNumber,
  collapseToTransitions, DayEntry,
} from './schedule';
import {
  plot, xOfMin, yOfTemp, tempColor, minOfX, tempOfY, makeScale, gridStep, Scale,
} from './geometry';

const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const SVGNS = 'http://www.w3.org/2000/svg';
const DEFAULT_MODES = ['off', 'auto', 'heat', 'cool', 'heat_cool', 'dry', 'fan_only'];
const el = (n: string, a: Record<string, string | number>) => {
  const e = document.createElementNS(SVGNS, n);
  for (const k in a) e.setAttribute(k, String(a[k]));
  return e;
};
const hourLabel = (h: number) => {
  const hh = h % 24; const ap = hh < 12 ? 'a' : 'p'; const h12 = hh % 12 || 12;
  return `${h12}${ap}`;
};
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

@customElement('timeline-scheduler-card')
export class TimelineSchedulerCard extends LitElement {
  @property({ attribute: false }) public hass?: HassLike;
  @state() protected _config?: CardConfig;
  @state() protected _schedule?: Schedule;
  @state() protected _perDay?: Record<Weekday, DayEntry[]>;
  @state() protected _day: Weekday = todayKey();
  @state() protected _sel: string | null = null;
  @state() protected _locked = true;
  @state() protected _dirty = false;
  @state() protected _saving = false;
  @state() protected _error?: string;
  @state() protected _ovInput = '';
  @state() protected _hist?: { actual: { m: number; t: number }[]; targetRuns: { m: number; t: number }[][] };
  private _histFor?: string;
  private _loadedFor?: string;
  private _saveTimer?: ReturnType<typeof setTimeout>;
  private _editSeq = 0;

  public setConfig(config: CardConfig): void {
    if (!config) throw new Error('Invalid configuration');
    this._config = config;
  }
  public getCardSize(): number { return 7; }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = undefined; }
    // Flush a queued edit so navigating away mid-debounce doesn't drop the save.
    if (this._dirty) void this._sync();
  }

  protected updated(changed: PropertyValues): void {
    if ((changed.has('hass') || changed.has('_config')) && this.hass && this._config?.schedule_id
      && this._loadedFor !== this._config.schedule_id) {
      this._loadedFor = this._config.schedule_id;
      void this._load();
    }
    const svg = this.renderRoot.querySelector('svg.tl');
    if (svg) this._renderTimeline(svg as SVGSVGElement);
  }

  /** Fetch today's actual + set-to temperatures for the target (once per day/schedule). */
  protected _maybeLoadHistory(): void {
    const showable = !!this.hass && !!this._schedule
      && this._schedule.apply === 'climate_temperature' && this._day === todayKey();
    if (!showable) { this._hist = undefined; this._histFor = undefined; return; }
    const key = `${this._schedule!.id}:${this._day}`;
    if (this._histFor === key) return;
    this._histFor = key;
    const entity = this._schedule!.target.entity_id;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    void fetchHistory(this.hass!, entity, start.toISOString(), new Date().toISOString())
      .then((rows) => {
        const actual: { m: number; t: number }[] = [];
        const targetRuns: { m: number; t: number }[][] = [];
        let run: { m: number; t: number }[] = [];
        for (const r of [...rows].sort((a, b) => a.lu - b.lu)) {
          const a = r.a || {};
          const d = new Date(r.lu * 1000); const m = d.getHours() * 60 + d.getMinutes();
          const ct = Number(a.current_temperature); if (Number.isFinite(ct)) actual.push({ m, t: ct });
          // The `temperature` attribute persists when the unit is off — only
          // treat it as a real target while the unit is in an active mode.
          const off = r.s === 'off' || r.s === 'unavailable' || r.s === 'unknown';
          const tt = Number(a.temperature);
          if (!off && Number.isFinite(tt)) run.push({ m, t: tt });
          else if (run.length) { targetRuns.push(run); run = []; }
        }
        if (run.length) targetRuns.push(run);
        this._hist = { actual, targetRuns };
        this.requestUpdate();
      })
      .catch(() => { this._hist = undefined; });
  }

  protected async _load(): Promise<void> {
    if (!this.hass || !this._config?.schedule_id) return;
    try {
      const sch = await getSchedule(this.hass, this._config.schedule_id);
      this._schedule = sch; this._perDay = expandByDay(sch); this._dirty = false; this._error = undefined;
    } catch (err) {
      this._error = `Couldn't load schedule "${this._config.schedule_id}": ${err instanceof Error ? err.message : String(err)}`;
    }
    this._maybeLoadHistory();
    this.requestUpdate();
  }

  // ---- units / scale / modes ------------------------------------------------
  protected _unit(): TempUnit {
    const u = this._config?.unit;
    if (u === 'C' || u === 'F') return u;
    const sys = this.hass?.config?.unit_system?.temperature;
    return sys && sys.includes('C') ? 'C' : 'F';
  }
  protected _scale(): Scale {
    const vals: number[] = [];
    if (this._perDay) for (const d of WEEKDAYS) for (const e of this._perDay[d]) { const t = vTemp(e.value); if (t !== null) vals.push(t); }
    // Device min/max are in the HA system unit; only apply when the card unit matches.
    const bounds = this._unitMatchesSystem() ? this._targetBounds() : undefined;
    return makeScale(this._unit(), vals, bounds);
  }
  protected _unitMatchesSystem(): boolean {
    const forced = this._config?.unit;
    if (forced !== 'C' && forced !== 'F') return true; // 'auto' follows the system
    const sys = this.hass?.config?.unit_system?.temperature;
    return (sys && sys.includes('C') ? 'C' : 'F') === forced;
  }
  protected _targetBounds(): { min: number; max: number } | undefined {
    const t = this._schedule?.target.entity_id;
    const a = t ? this.hass?.states[t]?.attributes : undefined;
    if (!a) return undefined;
    const lo = a.min_temp ?? a.min, hi = a.max_temp ?? a.max; // climate: min_temp/max_temp; number: min/max
    if (lo != null && hi != null && Number(hi) > Number(lo)) return { min: Number(lo), max: Number(hi) };
    return undefined;
  }
  protected _applyKind(): 'temp' | 'onoff' | 'number' {
    switch (this._schedule?.apply) {
      case 'switch_onoff': return 'onoff';
      case 'number_set': return 'number';
      default: return 'temp'; // climate_temperature — temperature and/or HVAC mode per setpoint
    }
  }
  protected _modeOptions(): string[] {
    const t = this._schedule?.target.entity_id;
    const m = t ? this.hass?.states[t]?.attributes?.hvac_modes : undefined;
    return Array.isArray(m) && m.length ? m : DEFAULT_MODES;
  }
  protected _midTemp(): number { const s = this._scale(); return Math.round((s.tmin + s.tmax) / 2); }
  protected _defaultValue(): SetVal {
    const k = this._applyKind();
    if (k === 'onoff') return mkSwitch('on');
    if (k === 'number') return mkNumber(0);
    return mkClimate(null, this._midTemp()); // climate: temperature-only, uses the schedule on-mode
  }
  protected _fmtVal(v: SetVal): string {
    const k = this._applyKind();
    if (k === 'onoff') return vOn(v) ? 'On' : 'Off';
    if (k === 'number') return String(vNumber(v));
    const t = vTemp(v), m = vMode(v); // climate
    if (t !== null) return m && m !== 'off' ? `${titleCase(m)} ${t}°` : `${t}°`;
    return m ? titleCase(m) : '—';
  }

  protected _activeDay(): DayEntry[] { return this._perDay ? this._perDay[this._day] : []; }
  protected _selEntry(): DayEntry | undefined { return this._activeDay().find((e) => e.id === this._sel); }
  /** Active day's setpoints ordered by resolved time (unresolvable anchors last). */
  protected _sortedDay(): DayEntry[] {
    const entries = this._activeDay();
    if (!this.hass) return entries;
    return [...entries].sort((a, b) => {
      const ma = resolveMin(a, this.hass!), mb = resolveMin(b, this.hass!);
      if (ma === null) return mb === null ? 0 : 1;
      if (mb === null) return -1;
      return ma - mb;
    });
  }

  // ---- timeline rendering ---------------------------------------------------
  protected _renderTimeline(svg: SVGSVGElement): void {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!this.hass || !this._perDay) return;
    const scale = this._scale();
    const entries = this._activeDay();
    const g = (n: string, a: Record<string, string | number>) => { const e = el(n, a); svg.appendChild(e); return e; };
    if (this._applyKind() === 'onoff') { this._renderOnOff(svg, entries, scale); return; }
    // temperature gridlines + axis
    const step = gridStep(scale.unit);
    for (let t = Math.ceil(scale.tmin / step) * step; t <= scale.tmax; t += step) {
      g('line', { class: 'grid', x1: plot.L, y1: yOfTemp(t, scale), x2: plot.R, y2: yOfTemp(t, scale) });
      const tx = g('text', { class: 'axis', x: plot.L - 9, y: yOfTemp(t, scale) + 4, 'text-anchor': 'end' }); tx.textContent = `${t}°`;
    }
    // mode band
    g('line', { class: 'grid', x1: plot.L, y1: plot.mode, x2: plot.R, y2: plot.mode });
    const ot = g('text', { class: 'axis', x: plot.L - 9, y: plot.mode + 4, 'text-anchor': 'end' }); ot.textContent = 'mode';
    // hour axis (12h labels)
    for (let h = 0; h <= 24; h += 3) {
      g('line', { class: 'grid', x1: xOfMin(h * 60), y1: plot.T, x2: xOfMin(h * 60), y2: plot.mode });
      const ax = g('text', { class: 'axis', x: xOfMin(h * 60), y: plot.axis, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle' });
      ax.textContent = hourLabel(h);
    }
    // segments (step function)
    for (const s of daySegments(entries, this.hass)) {
      const x0 = xOfMin(s.m0), w = Math.max(0, xOfMin(s.m1) - x0);
      const t = vTemp(s.value);
      if (t !== null) {
        const c = tempColor(t, scale), y = yOfTemp(t, scale);
        g('rect', { x: x0, y, width: w, height: plot.B - y, fill: c, opacity: 0.16 });
        g('line', { class: 'segline', x1: x0, y1: y, x2: xOfMin(s.m1), y2: y, stroke: c });
      } else {
        g('rect', { x: x0, y: plot.mode - 6, width: w, height: 12, rx: 3, class: 'seg-mode' });
      }
    }
    // historical overlay: actual temperature + what it was actually set to (today only).
    // The set-to line breaks while the unit was off (no active target).
    if (this._hist && this._day === todayKey()) {
      for (const runPts of this._hist.targetRuns) {
        if (runPts.length < 2) continue;
        const step: string[] = []; let prev: { m: number; t: number } | null = null;
        for (const p of runPts) {
          if (prev) step.push(`${xOfMin(p.m)},${yOfTemp(prev.t, scale)}`);
          step.push(`${xOfMin(p.m)},${yOfTemp(p.t, scale)}`); prev = p;
        }
        g('polyline', { class: 'hist-target', points: step.join(' ') });
      }
      if (this._hist.actual.length) {
        g('polyline', { class: 'hist-actual', points: this._hist.actual.map((p) => `${xOfMin(p.m)},${yOfTemp(p.t, scale)}`).join(' ') });
      }
    }
    // now line
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    g('line', { class: 'nowline', x1: xOfMin(nm), y1: plot.T, x2: xOfMin(nm), y2: plot.mode });
    // dots + value labels
    for (const e of entries) {
      const m = resolveMin(e, this.hass); if (m === null) continue;
      const t = vTemp(e.value); const cy = t !== null ? yOfTemp(t, scale) : plot.mode;
      this._addDot(svg, e, xOfMin(m), cy, t !== null ? tempColor(t, scale) : 'var(--tsc-mode)', scale);
    }
  }

  /** Draw + wire a draggable setpoint dot at (cx, cy). */
  protected _addDot(svg: SVGSVGElement, e: DayEntry, cx: number, cy: number, fill: string, scale: Scale): void {
    const grp = el('g', { class: 'dot' + (e.id === this._sel ? ' sel' : '') + (this._locked ? ' ro' : ''), 'data-id': e.id, tabindex: 0 });
    grp.appendChild(el('circle', { class: 'hit', cx, cy, r: 18 }));
    if (e.kind === 'anchor') grp.appendChild(el('circle', { class: 'ring', cx, cy, r: 11 }));
    grp.appendChild(el('circle', { class: 'body', cx, cy, r: 7, fill }));
    const ly = cy - 12 < plot.T + 8 ? cy + 20 : cy - 12; // flip below when near the top edge
    const lbl = el('text', { class: 'vlabel', x: cx, y: ly, 'text-anchor': 'middle' });
    lbl.textContent = this._fmtVal(e.value); grp.appendChild(lbl);
    svg.appendChild(grp);
    this._wireDot(grp as SVGGElement, e, scale);
  }

  /** Simple two-level On/Off timeline (switch_onoff schedules). */
  protected _renderOnOff(svg: SVGSVGElement, entries: DayEntry[], scale: Scale): void {
    const g = (n: string, a: Record<string, string | number>) => { const e2 = el(n, a); svg.appendChild(e2); return e2; };
    const onY = plot.T + 26, offY = plot.B - 6;
    const isOn = (v: SetVal) => vOn(v);
    const levels: [number, string][] = [[onY, 'On'], [offY, 'Off']];
    for (const [y, label] of levels) {
      g('line', { class: 'grid', x1: plot.L, y1: y, x2: plot.R, y2: y });
      const tx = g('text', { class: 'axis', x: plot.L - 9, y: y + 4, 'text-anchor': 'end' }); tx.textContent = label;
    }
    for (let h = 0; h <= 24; h += 3) {
      g('line', { class: 'grid', x1: xOfMin(h * 60), y1: plot.T, x2: xOfMin(h * 60), y2: offY });
      const ax = g('text', { class: 'axis', x: xOfMin(h * 60), y: plot.axis, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle' });
      ax.textContent = hourLabel(h);
    }
    let prevY: number | null = null;
    for (const s of daySegments(entries, this.hass!)) {
      const y = isOn(s.value) ? onY : offY;
      const x0 = xOfMin(s.m0), x1 = xOfMin(s.m1);
      if (isOn(s.value)) g('rect', { x: x0, y: onY, width: Math.max(0, x1 - x0), height: offY - onY, fill: 'var(--primary-color)', opacity: 0.14 });
      if (prevY !== null) g('line', { class: 'segline', x1: x0, y1: prevY, x2: x0, y2: y, stroke: 'var(--primary-color)' });
      g('line', { class: 'segline', x1: x0, y1: y, x2: x1, y2: y, stroke: 'var(--primary-color)' });
      prevY = y;
    }
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    g('line', { class: 'nowline', x1: xOfMin(nm), y1: plot.T, x2: xOfMin(nm), y2: offY });
    for (const e of entries) {
      const m = resolveMin(e, this.hass!); if (m === null) continue;
      this._addDot(svg, e, xOfMin(m), isOn(e.value) ? onY : offY, 'var(--primary-color)', scale);
    }
  }
  protected _wireDot(grp: SVGGElement, e: DayEntry, scale: Scale): void {
    grp.addEventListener('pointerdown', (ev: PointerEvent) => {
      this._sel = e.id;
      if (this._locked) { this.requestUpdate(); return; }
      ev.preventDefault();
      const svg = grp.ownerSVGElement!;
      // Capture on the <svg> (which persists across re-renders), not on the
      // dot <g> (which _renderTimeline recreates on every move) — so the drag
      // keeps tracking even when the pointer moves fast or leaves the chart.
      svg.setPointerCapture(ev.pointerId);
      const toSvg = (px: number, py: number) => { const p = svg.createSVGPoint(); p.x = px; p.y = py; return p.matrixTransform(svg.getScreenCTM()!.inverse()); };
      const alarm = e.kind === 'anchor' ? resolveMin({ ...e, offsetMin: 0 } as DayEntry, this.hass!) : null;
      const move = (m2: PointerEvent) => {
        const p = toSvg(m2.clientX, m2.clientY);
        const min = Math.max(0, Math.min(1435, Math.round(minOfX(p.x) / 5) * 5));
        if (e.kind === 'time') e.atMin = min;
        else if (alarm !== null) e.offsetMin = Math.max(-720, Math.min(720, Math.round((min - alarm) / 5) * 5));
        if (vTemp(e.value) !== null) {
          const temp = Math.max(scale.tmin, Math.min(scale.tmax, Math.round(tempOfY(p.y, scale))));
          e.value = { ...e.value, temp };
        }
        this.requestUpdate();
      };
      const up = () => {
        try { svg.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
        svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up);
        this._scheduleSync();
      };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up);
    });
  }

  // ---- mutations + auto-save ------------------------------------------------
  protected _scheduleSync(): void {
    this._dirty = true; this._editSeq++; this.requestUpdate();
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => void this._sync(), 700);
  }
  protected async _sync(): Promise<void> {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = undefined; }
    if (!this.hass || !this._schedule || !this._perDay) return;
    const seq = this._editSeq;
    const next: Schedule = { ...this._schedule, transitions: collapseToTransitions(this._perDay) };
    this._saving = true; this.requestUpdate();
    try {
      await saveSchedule(this.hass, next);
      this._schedule = next; this._error = undefined;
      // Only mark clean if no newer edit arrived while this save was in flight.
      if (this._editSeq === seq) this._dirty = false;
    } catch (err) {
      this._error = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this._saving = false; this.requestUpdate();
  }
  protected _mutateSel(fn: (e: DayEntry) => void): void {
    const e = this._selEntry(); if (!e) return; fn(e); this._scheduleSync();
  }
  protected _addSetpoint(): void {
    if (!this._perDay) return;
    const id = 'n' + Math.random().toString(36).slice(2);
    this._perDay[this._day].push({ id, kind: 'time', atMin: 12 * 60, value: this._defaultValue() });
    this._sel = id; this._scheduleSync();
  }
  protected _remove(id: string): void {
    if (!this._perDay) return;
    this._perDay[this._day] = this._perDay[this._day].filter((e) => e.id !== id);
    if (this._sel === id) this._sel = null;
    this._scheduleSync();
  }
  protected _copyDayTo(target: Weekday): void {
    if (!this._perDay || target === this._day) return;
    this._perDay[target] = this._activeDay().map((e) => ({ ...e, id: 'c' + Math.random().toString(36).slice(2) }));
    this._scheduleSync();
  }
  protected _copyDayToAll(): void {
    if (!this._perDay) return;
    for (const d of WEEKDAYS) {
      if (d === this._day) continue;
      this._perDay[d] = this._activeDay().map((e) => ({ ...e, id: 'c' + Math.random().toString(36).slice(2) }));
    }
    this._scheduleSync();
  }
  protected _toggleLock(): void { this._locked = !this._locked; if (this._locked) this._sel = null; }

  protected _deviceId(): string | undefined {
    const sid = this._config?.schedule_id;
    if (!sid || !this.hass?.devices) return undefined;
    const dev = Object.values(this.hass.devices).find((d) =>
      (d.identifiers || []).some((idf) => idf[0] === 'timeline_scheduler' && idf[1] === sid));
    return dev?.id;
  }
  protected _openDevice(): void {
    const id = this._deviceId();
    if (!id) return;
    history.pushState(null, '', `/config/devices/device/${id}`);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false }, bubbles: true, composed: true }));
  }

  static async getConfigElement() { await import('./editor'); return document.createElement('timeline-scheduler-card-editor'); }
  static async getStubConfig(hass: HassLike) {
    try { const list = await listSchedules(hass); if (list.length) return { schedule_id: list[0].id }; } catch { /* none */ }
    return { schedule_id: '' };
  }

  private _statusNow() {
    if (!this.hass || !this._perDay) return { cur: '—', next: '' };
    const pts = this._activeDay().map((e) => ({ m: resolveMin(e, this.hass!), v: e.value })).filter((p) => p.m !== null).sort((a, b) => (a.m! - b.m!));
    if (!pts.length) return { cur: '—', next: '' };
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    let cur = pts[pts.length - 1]; for (const p of pts) if (p.m! <= nm) cur = p;
    const nxt = pts.find((p) => p.m! > nm) ?? pts[0];
    return { cur: this._fmtVal(cur.v), next: `→ ${this._fmtVal(nxt.v)} at ${fmtClock(nxt.m!, this.hass)}` };
  }

  /** The value the schedule would be holding right now (today). */
  protected _plannedNow(): SetVal | undefined {
    if (!this._perDay || !this.hass) return undefined;
    const pts = this._activeDay().map((e) => ({ m: resolveMin(e, this.hass!), v: e.value })).filter((p) => p.m !== null).sort((a, b) => (a.m! - b.m!));
    if (!pts.length) return this._schedule?.default?.value ?? undefined;
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    let cur = pts[pts.length - 1].v; for (const p of pts) if (p.m! <= nm) cur = p.v;
    return cur;
  }

  /** True when the target's actual value diverges from the scheduled value now
   *  (a manual override OR an external change), plus that actual value. */
  protected _overrideInfo(): { active: boolean; actual?: SetVal } {
    if (!this.hass || !this._schedule || this._day !== todayKey()) return { active: false };
    const st = this.hass.states[this._schedule.target.entity_id];
    if (!st) return { active: false };
    const planned = this._plannedNow();
    if (!planned) return { active: false };
    let actual: SetVal | undefined;
    switch (this._applyKind()) {
      case 'onoff': actual = mkSwitch(st.state === 'on' ? 'on' : 'off'); break;
      case 'number': { const n = Number(st.state); if (Number.isFinite(n)) actual = mkNumber(n); break; }
      default: {
        // climate: the actual mode is the entity state; the target temp lives in
        // the `temperature` attribute (meaningless while off).
        const t = st.state === 'off' ? null
          : (st.attributes && st.attributes.temperature != null ? Number(st.attributes.temperature) : null);
        actual = mkClimate(st.state, t);
      }
    }
    if (!actual) return { active: false };
    return { active: !this._sameValue(planned, actual), actual };
  }

  /** Whether a scheduled value and the target's actual value are equivalent now. */
  protected _sameValue(planned: SetVal, actual: SetVal): boolean {
    const kind = this._applyKind();
    if (kind === 'onoff') return vOn(planned) === vOn(actual);
    if (kind === 'number') return Math.abs(vNumber(planned) - vNumber(actual)) < 0.5;
    // climate: a temperature-only setpoint (no explicit mode) resolves to on_mode.
    const pMode = (vMode(planned) ?? this._schedule?.on_mode ?? '').toLowerCase();
    const aMode = (vMode(actual) ?? '').toLowerCase();
    if (pMode !== aMode) return false;
    if (pMode === 'off') return true;             // off carries no temperature
    const pTemp = vTemp(planned);
    if (pTemp === null) return true;              // planned didn't pin a temperature
    const aTemp = vTemp(actual);
    return aTemp !== null && Math.abs(pTemp - aTemp) < 0.5;
  }

  render() {
    if (!this._config) return html``;
    const s = this._schedule; const st = this._statusNow(); const scale = this._scale(); const ov = this._overrideInfo();
    return html`
      <ha-card>
        <div class="head">
          <div class="title ${this._deviceId() ? 'link' : ''}" role="button" tabindex="0"
            title=${this._deviceId() ? 'Open device' : ''} @click=${() => this._openDevice()}>
            <h2>${this._config.name ?? s?.name ?? 'Schedule'}</h2>
          </div>
          <div class="now">
            <div class="cur">${ov.active ? this._fmtVal(ov.actual!) : st.cur}</div>
            ${ov.active
              ? html`<div class="nxt"><span class="ovbadge">Override</span><button class="reslink" title="Re-apply the schedule now" @click=${() => this._clearOverride()}>Resume</button></div>`
              : html`<div class="nxt">${st.next}</div>`}
          </div>
          <button class="lock" title=${this._locked ? 'Locked — tap to edit' : 'Unlocked — tap to lock'}
            aria-pressed=${!this._locked} @click=${() => this._toggleLock()}>${this._locked ? '🔒' : '🔓'}</button>
        </div>
        <div class="status">
          ${this._error ? html`<span class="err">${this._error}</span>`
            : this._saving ? html`<span class="sync">Saving…</span>`
            : this._dirty ? html`<span class="sync">Unsaved…</span>`
            : this._locked ? nothing : html`<span class="ok">Changes save automatically</span>`}
        </div>
        <div class="days">
          ${WEEKDAYS.map((d) => html`<button class="day" aria-pressed=${d === this._day} @click=${() => { this._day = d; this._sel = null; this._maybeLoadHistory(); }}>${DAY_LABEL[d]}</button>`)}
        </div>
        <svg class="tl" viewBox="0 0 500 262" preserveAspectRatio="xMidYMid meet" aria-label="setpoint timeline"></svg>
        ${this._hist && this._day === todayKey() ? html`<div class="legend">
          <span><i class="ln sched"></i>Scheduled</span>
          <span><i class="ln act"></i>Actual</span>
          <span><i class="ln tgt"></i>Was set to</span>
        </div>` : nothing}
        <div class="list">
          ${this._sortedDay().map((e) => this._row(e, scale))}
        </div>
        ${this._detail()}
        ${this._onModeRow()}
        ${this._locked ? nothing : this._overrideRow()}
        ${this._footer()}
      </ha-card>`;
  }

  // ---- manual override ------------------------------------------------------
  protected _overrideRow() {
    const kind = this._applyKind();
    if (kind === 'onoff') {
      return html`<div class="override">
        <span class="olabel">Override now</span>
        <button class="obtn" @click=${() => this._doOverride(mkSwitch('on'))}>On</button>
        <button class="obtn" @click=${() => this._doOverride(mkSwitch('off'))}>Off</button>
        <button class="obtn clr" @click=${() => this._clearOverride()}>Resume schedule</button>
      </div>`;
    }
    const mk = (n: number) => (kind === 'number' ? mkNumber(n) : mkClimate(null, n));
    return html`<div class="override">
      <span class="olabel">Override now</span>
      <input class="num" type="number" .value=${this._ovInput} placeholder="value"
        @input=${(e: Event) => { this._ovInput = (e.target as HTMLInputElement).value; }} />
      <button class="obtn" ?disabled=${this._ovInput === ''}
        @click=${() => this._doOverride(mk(Number(this._ovInput)))}>Hold until next change</button>
      <button class="obtn clr" @click=${() => this._clearOverride()}>Resume schedule</button>
    </div>`;
  }
  protected async _doOverride(value: SetVal): Promise<void> {
    if (!this.hass || !this._config?.schedule_id) return;
    try { await setOverride(this.hass, this._config.schedule_id, value); this._error = undefined; }
    catch (err) { this._error = `Override failed: ${err instanceof Error ? err.message : String(err)}`; }
    this.requestUpdate();
  }
  protected async _clearOverride(): Promise<void> {
    if (!this.hass || !this._config?.schedule_id) return;
    try { await clearOverride(this.hass, this._config.schedule_id); this._error = undefined; }
    catch (err) { this._error = `Resume failed: ${err instanceof Error ? err.message : String(err)}`; }
    this.requestUpdate();
  }

  protected _row(e: DayEntry, scale: Scale) {
    const m = resolveMin(e, this.hass!); const t = vTemp(e.value);
    return html`<div class="row ${e.id === this._sel ? 'sel' : ''}" @click=${() => (this._sel = e.id)}>
      <span class="sw" style=${`background:${t !== null ? tempColor(t, scale) : 'var(--tsc-mode)'}`}></span>
      <span class="when">${m === null ? '—' : fmtClock(m, this.hass)}</span>
      <span class="kind ${e.kind}">${e.kind === 'anchor' ? `⏰ ${e.entity ? shortEntity(e.entity) : 'entity'}` : 'fixed'}</span>
      <span class="temp">${this._fmtVal(e.value)}</span>
      ${this._locked ? nothing : html`<button class="rm" title="Remove" @click=${(ev: Event) => { ev.stopPropagation(); this._remove(e.id); }}>×</button>`}
    </div>`;
  }

  // ---- selected-setpoint editor (manual entry) ------------------------------
  protected _detail() {
    if (this._locked || !this._sel) return nothing;
    const e = this._selEntry(); if (!e) return nothing;
    return html`<div class="detail">
      <div class="drow">
        <span class="dlabel">Time</span>
        <div class="seg">
          <button class=${e.kind === 'time' ? 'on' : ''} @click=${() => this._setTiming(e, 'time')}>Fixed time</button>
          <button class=${e.kind === 'anchor' ? 'on' : ''} @click=${() => this._setTiming(e, 'anchor')}>HA entity</button>
        </div>
      </div>
      ${e.kind === 'time' ? html`
        <div class="drow"><span class="dlabel"></span>
          <input type="time" .value=${fmtMin(e.atMin ?? 0)} @change=${(ev: Event) => this._mutateSel((x) => { x.atMin = parseHHMM((ev.target as HTMLInputElement).value || '00:00'); })} />
        </div>`
        : html`
        <div class="drow"><span class="dlabel">Entity</span>
          <ha-entity-picker .hass=${this.hass} .value=${e.entity ?? ''} allow-custom-entity
            @value-changed=${(ev: any) => this._mutateSel((x) => { x.entity = ev.detail.value; })}></ha-entity-picker>
        </div>
        <div class="drow"><span class="dlabel">Offset</span>
          <input class="num" type="number" step="5" .value=${String(e.offsetMin ?? 0)}
            @change=${(ev: Event) => this._mutateSel((x) => { x.offsetMin = Math.round(Number((ev.target as HTMLInputElement).value) || 0); })} />
          <span class="hint">minutes (negative = before)</span>
        </div>`}
      ${this._valueEditor(e)}
    </div>`;
  }

  protected _valueEditor(e: DayEntry) {
    const kind = this._applyKind();
    if (kind === 'onoff') {
      const on = vOn(e.value);
      return html`<div class="drow"><span class="dlabel">Value</span>
        <div class="seg">
          <button class=${on ? 'on' : ''} @click=${() => this._mutateSel((x) => { x.value = mkSwitch('on'); })}>On</button>
          <button class=${!on ? 'on' : ''} @click=${() => this._mutateSel((x) => { x.value = mkSwitch('off'); })}>Off</button>
        </div></div>`;
    }
    if (kind === 'number') {
      return html`<div class="drow"><span class="dlabel">Value</span>
        <input class="num" type="number" .value=${String(vNumber(e.value))}
          @change=${(ev: Event) => this._mutateSel((x) => { x.value = mkNumber(Number((ev.target as HTMLInputElement).value) || 0); })} /></div>`;
    }
    // climate_temperature: an HVAC mode and/or a temperature.
    const curMode = vMode(e.value); // null → use the schedule's on-mode
    const temp = vTemp(e.value);
    const opts = this._modeOptions();
    const list = curMode && !opts.includes(curMode) ? [curMode, ...opts] : opts;
    return html`
      <div class="drow"><span class="dlabel">Mode</span>
        <select class="sel" @change=${(ev: Event) => this._setMode((ev.target as HTMLSelectElement).value)}>
          <option value="" ?selected=${curMode === null}>Default (turn-on mode)</option>
          ${list.map((o) => html`<option value=${o} ?selected=${o === curMode}>${titleCase(o)}</option>`)}
        </select></div>
      ${curMode === 'off' ? nothing : html`
        <div class="drow"><span class="dlabel">Temp</span>
          <input class="num" type="number" placeholder="—" .value=${temp === null ? '' : String(temp)}
            @change=${(ev: Event) => this._setTemp((ev.target as HTMLInputElement).value)} />
          <span class="hint">°${this._unit()}</span></div>`}`;
  }

  /** Change the selected climate setpoint's mode; 'off' drops any temperature,
   *  and a temperature-only default gets a starting temperature. */
  protected _setMode(val: string): void {
    this._mutateSel((x) => {
      const mode = val === '' ? null : val;
      let temp = vTemp(x.value);
      if (mode === 'off') temp = null;
      else if (temp === null) temp = this._midTemp();
      x.value = mkClimate(mode, temp);
    });
  }
  protected _setTemp(raw: string): void {
    this._mutateSel((x) => {
      const temp = raw.trim() === '' ? null : Math.round(Number(raw) || 0);
      x.value = mkClimate(vMode(x.value), temp);
    });
  }

  /** Schedule-level "turn on as" mode (climate only). */
  protected _onModeRow() {
    if (this._locked || this._applyKind() !== 'temp') return nothing;
    const opts = this._modeOptions().filter((m) => m !== 'off');
    const cur = this._schedule?.on_mode ?? '';
    return html`<div class="onmode">
      <span class="olabel">Turn on as</span>
      <select class="sel" @change=${(ev: Event) => this._setOnMode((ev.target as HTMLSelectElement).value)}>
        <option value="" ?selected=${!cur}>—</option>
        ${opts.map((o) => html`<option value=${o} ?selected=${o === cur}>${titleCase(o)}</option>`)}
      </select>
      <span class="hint">used when a setpoint sets a temperature but no mode</span>
    </div>`;
  }
  protected _setOnMode(val: string): void {
    if (!this._schedule) return;
    this._schedule = { ...this._schedule, on_mode: val || null };
    this._scheduleSync();
  }

  protected _setTiming(e: DayEntry, kind: 'time' | 'anchor'): void {
    if (e.kind === kind) return;
    this._mutateSel((x) => {
      if (kind === 'time') { const m = resolveMin(x, this.hass!); x.kind = 'time'; x.atMin = m ?? 12 * 60; x.entity = undefined; x.offsetMin = undefined; }
      else { x.kind = 'anchor'; x.entity = x.entity ?? ''; x.offsetMin = x.offsetMin ?? 0; x.atMin = undefined; }
    });
  }

  protected _footer() {
    if (this._locked) return nothing;
    return html`<div class="foot">
      <button class="act" @click=${() => this._addSetpoint()}>＋ Add setpoint</button>
      <button class="act" title="Copy this day's setpoints to every other day" @click=${() => this._copyDayToAll()}>Copy to all days</button>
      <select class="act" @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) { this._copyDayTo(v as Weekday); (e.target as HTMLSelectElement).value = ''; } }}>
        <option value="">Copy day to…</option>
        ${WEEKDAYS.filter((d) => d !== this._day).map((d) => html`<option value=${d}>${DAY_LABEL[d]}</option>`)}
      </select>
    </div>`;
  }

  static styles = css`
    :host { display: block; --tsc-mode: #8b5cf6; }
    .head { display: flex; gap: 16px; padding: 16px 16px 6px; align-items: flex-start; }
    .title { border-radius: 8px; }
    .title.link { cursor: pointer; }
    .title.link:hover h2 { color: var(--primary-color); }
    .title h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
    .now { margin-left: auto; text-align: right; }
    .now .cur { font-size: 22px; font-weight: 700; color: var(--primary-text-color); }
    .now .nxt { font-size: 12px; color: var(--secondary-text-color); }
    .ovbadge { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: var(--warning-color, #e0a020); border: 1px solid var(--warning-color, #e0a020); padding: 0 6px; border-radius: 999px; margin-right: 6px; }
    .reslink { font: inherit; font-size: 12px; border: none; background: transparent; color: var(--primary-color); cursor: pointer; padding: 0; text-decoration: underline; }
    .lock { border: none; background: transparent; cursor: pointer; font-size: 18px; padding: 2px 4px; border-radius: 8px; line-height: 1; }
    .lock:hover { background: var(--secondary-background-color); }
    .status { min-height: 16px; padding: 0 16px 6px; font-size: 12px; }
    .status .sync { color: var(--primary-color); } .status .ok { color: var(--secondary-text-color); } .status .err { color: var(--error-color); }
    .days { display: flex; gap: 6px; padding: 0 16px 12px; }
    .day { flex: 1; padding: 7px 0; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
      background: var(--secondary-background-color); color: var(--secondary-text-color); border: 1px solid var(--divider-color); }
    .day[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color); border-color: var(--primary-color); }
    svg.tl { display: block; width: 100%; height: auto; touch-action: none; }
    .grid { stroke: var(--divider-color); stroke-width: 1; opacity: .5; }
    .axis { fill: var(--secondary-text-color); font-size: 12px; font-family: var(--code-font-family, monospace); }
    .segline { stroke-width: 2.5; stroke-linecap: round; }
    .seg-mode { fill: var(--tsc-mode); opacity: .3; }
    .nowline { stroke: var(--secondary-text-color); stroke-width: 1; stroke-dasharray: 2 3; opacity: .6; }
    .hist-actual { fill: none; stroke: var(--primary-text-color); stroke-width: 1.4; opacity: .75; stroke-linejoin: round; stroke-linecap: round; }
    .hist-target { fill: none; stroke: var(--secondary-text-color); stroke-width: 1.4; opacity: .6; stroke-dasharray: 4 3; stroke-linejoin: round; }
    .legend { display: flex; gap: 14px; padding: 2px 16px 8px; font-size: 11px; color: var(--secondary-text-color); flex-wrap: wrap; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend .ln { width: 14px; height: 0; border-top: 2px solid currentColor; display: inline-block; }
    .legend .ln.sched { border-top-color: var(--primary-color); border-top-width: 3px; }
    .legend .ln.act { border-top-color: var(--primary-text-color); }
    .legend .ln.tgt { border-top-style: dashed; }
    .vlabel { fill: var(--primary-text-color); font-size: 14px; font-weight: 700; paint-order: stroke;
      stroke: var(--card-background-color); stroke-width: 3.5px; stroke-linejoin: round; }
    .dot { cursor: grab; } .dot:active { cursor: grabbing; } .dot.ro { cursor: pointer; }
    .dot .hit { fill: transparent; } .dot .body { stroke: var(--card-background-color); stroke-width: 2; }
    .dot.sel .body { stroke: var(--primary-text-color); }
    .dot .ring { fill: none; stroke: var(--primary-color); stroke-width: 1.4; stroke-dasharray: 2.5 2.5; }
    .list { padding: 6px 10px 4px; }
    .row { display: flex; gap: 10px; align-items: center; padding: 8px 8px; border-radius: 8px; cursor: pointer; }
    .row:hover, .row.sel { background: var(--secondary-background-color); }
    .sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
    .when { font-family: var(--code-font-family, monospace); min-width: 74px; color: var(--primary-text-color); }
    .kind { font-size: 11px; color: var(--secondary-text-color); border: 1px solid var(--divider-color); padding: 1px 7px; border-radius: 999px; }
    .kind.anchor { color: var(--primary-color); border-color: var(--primary-color); }
    .temp { margin-left: auto; font-weight: 700; color: var(--primary-text-color); font-family: var(--code-font-family, monospace); }
    .rm{margin-left:6px;border:none;background:transparent;color:var(--secondary-text-color);cursor:pointer;font-size:15px;border-radius:6px;width:24px;height:24px}.rm:hover{color:var(--error-color)}
    .detail { margin: 4px 12px 8px; padding: 12px; border: 1px solid var(--divider-color); border-radius: 12px; background: var(--secondary-background-color); display: flex; flex-direction: column; gap: 10px; }
    .drow { display: flex; gap: 10px; align-items: center; }
    .dlabel { width: 56px; font-size: 12px; color: var(--secondary-text-color); flex: none; }
    .seg { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 8px; overflow: hidden; }
    .seg button { font: inherit; font-size: 13px; padding: 6px 12px; border: none; cursor: pointer; background: var(--card-background-color); color: var(--primary-text-color); }
    .seg button.on { background: var(--primary-color); color: var(--text-primary-color); }
    .num, .sel { font: inherit; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
    .num { width: 90px; }
    input[type=time] { font: inherit; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
    ha-entity-picker { flex: 1; }
    .hint { font-size: 12px; color: var(--secondary-text-color); }
    .onmode { display: flex; gap: 8px; align-items: center; margin: 0 12px 8px; padding: 8px 10px;
      border: 1px solid var(--divider-color); border-radius: 10px; flex-wrap: wrap; }
    .override { display: flex; gap: 8px; align-items: center; margin: 0 12px 8px; padding: 8px 10px;
      border: 1px dashed var(--divider-color); border-radius: 10px; }
    .olabel { font-size: 12px; color: var(--secondary-text-color); }
    .obtn { font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
    .obtn.clr { margin-left: auto; }
    .obtn[disabled] { opacity: .5; cursor: default; }
    .foot { display: flex; gap: 10px; padding: 10px 16px 16px; border-top: 1px solid var(--divider-color); }
    button.act { font: inherit; font-weight: 600; font-size: 13px; border-radius: 8px; padding: 9px 13px; cursor: pointer;
      border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); }
  `;
}
function todayKey(): Weekday { return WEEKDAYS[(new Date().getDay() + 6) % 7]; }
function shortEntity(id: string): string { const p = id.split('.'); return p[p.length - 1]; }
