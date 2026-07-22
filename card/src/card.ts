import { LitElement, html, css, PropertyValues, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HassLike, Schedule, Weekday, SetVal, TempUnit, CardConfig } from './types';
import { WEEKDAYS } from './types';
import { getSchedule, saveSchedule, listSchedules } from './api';
import {
  expandByDay, daySegments, resolveMin, fmtMin, fmtClock, parseHHMM, isTemp,
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

  protected async _load(): Promise<void> {
    if (!this.hass || !this._config?.schedule_id) return;
    try {
      const sch = await getSchedule(this.hass, this._config.schedule_id);
      this._schedule = sch; this._perDay = expandByDay(sch); this._dirty = false; this._error = undefined;
    } catch (err) {
      this._error = `Couldn't load schedule "${this._config.schedule_id}": ${err instanceof Error ? err.message : String(err)}`;
    }
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
    if (this._perDay) for (const d of WEEKDAYS) for (const e of this._perDay[d]) if (isTemp(e.value)) vals.push(e.value);
    return makeScale(this._unit(), vals);
  }
  protected _applyKind(): 'temp' | 'mode' | 'onoff' | 'number' {
    switch (this._schedule?.apply) {
      case 'climate_hvac_mode': return 'mode';
      case 'switch_onoff': return 'onoff';
      case 'number_set': return 'number';
      default: return 'temp';
    }
  }
  protected _modeOptions(): string[] {
    const t = this._schedule?.target.entity_id;
    const m = t ? this.hass?.states[t]?.attributes?.hvac_modes : undefined;
    return Array.isArray(m) && m.length ? m : DEFAULT_MODES;
  }
  protected _defaultValue(): SetVal {
    const k = this._applyKind();
    if (k === 'onoff') return 'on';
    if (k === 'mode') return this._modeOptions()[0] ?? 'off';
    if (k === 'number') return 0;
    const s = this._scale(); return Math.round((s.tmin + s.tmax) / 2);
  }
  protected _fmtVal(v: SetVal): string {
    if (isTemp(v)) return `${v}°`;
    return titleCase(String(v));
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
      if (isTemp(s.value)) {
        const c = tempColor(s.value, scale), y = yOfTemp(s.value, scale);
        g('rect', { x: x0, y, width: w, height: plot.B - y, fill: c, opacity: 0.16 });
        g('line', { class: 'segline', x1: x0, y1: y, x2: xOfMin(s.m1), y2: y, stroke: c });
      } else {
        g('rect', { x: x0, y: plot.mode - 6, width: w, height: 12, rx: 3, class: 'seg-mode' });
      }
    }
    // now line
    const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
    g('line', { class: 'nowline', x1: xOfMin(nm), y1: plot.T, x2: xOfMin(nm), y2: plot.mode });
    // dots + value labels
    for (const e of entries) {
      const m = resolveMin(e, this.hass); if (m === null) continue;
      const temp = isTemp(e.value); const cx = xOfMin(m), cy = temp ? yOfTemp(e.value as number, scale) : plot.mode;
      const grp = el('g', { class: 'dot' + (e.id === this._sel ? ' sel' : '') + (this._locked ? ' ro' : ''), 'data-id': e.id, tabindex: 0 });
      grp.appendChild(el('circle', { class: 'hit', cx, cy, r: 18 }));
      if (e.kind === 'anchor') grp.appendChild(el('circle', { class: 'ring', cx, cy, r: 11 }));
      grp.appendChild(el('circle', { class: 'body', cx, cy, r: 7, fill: temp ? tempColor(e.value as number, scale) : 'var(--tsc-mode)' }));
      const ly = cy - 12 < plot.T + 8 ? cy + 20 : cy - 12; // flip below when near the top edge
      const lbl = el('text', { class: 'vlabel', x: cx, y: ly, 'text-anchor': 'middle' });
      lbl.textContent = this._fmtVal(e.value); grp.appendChild(lbl);
      svg.appendChild(grp);
      this._wireDot(grp as SVGGElement, e, scale);
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
        if (isTemp(e.value)) e.value = Math.max(scale.tmin, Math.min(scale.tmax, Math.round(tempOfY(p.y, scale))));
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

  render() {
    if (!this._config) return html``;
    const s = this._schedule; const st = this._statusNow(); const scale = this._scale();
    return html`
      <ha-card>
        <div class="head">
          <div class="title">
            <h2>${this._config.name ?? s?.name ?? 'Schedule'}</h2>
            <div class="target">${s?.target.entity_id ?? this._config.schedule_id ?? ''}</div>
          </div>
          <div class="now"><div class="cur">${st.cur}</div><div class="nxt">${st.next}</div></div>
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
          ${WEEKDAYS.map((d) => html`<button class="day" aria-pressed=${d === this._day} @click=${() => { this._day = d; this._sel = null; }}>${DAY_LABEL[d]}</button>`)}
        </div>
        <svg class="tl" viewBox="0 0 500 262" preserveAspectRatio="xMidYMid meet" aria-label="setpoint timeline"></svg>
        <div class="list">
          ${this._sortedDay().map((e) => this._row(e, scale))}
        </div>
        ${this._detail()}
        ${this._footer()}
      </ha-card>`;
  }

  protected _row(e: DayEntry, scale: Scale) {
    const m = resolveMin(e, this.hass!); const temp = isTemp(e.value);
    return html`<div class="row ${e.id === this._sel ? 'sel' : ''}" @click=${() => (this._sel = e.id)}>
      <span class="sw" style=${`background:${temp ? tempColor(e.value as number, scale) : 'var(--tsc-mode)'}`}></span>
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
      return html`<div class="drow"><span class="dlabel">Value</span>
        <div class="seg">
          <button class=${String(e.value) === 'on' ? 'on' : ''} @click=${() => this._mutateSel((x) => { x.value = 'on'; })}>On</button>
          <button class=${String(e.value) === 'off' ? 'on' : ''} @click=${() => this._mutateSel((x) => { x.value = 'off'; })}>Off</button>
        </div></div>`;
    }
    if (kind === 'number') {
      return html`<div class="drow"><span class="dlabel">Value</span>
        <input class="num" type="number" .value=${String(isTemp(e.value) ? e.value : 0)}
          @change=${(ev: Event) => this._mutateSel((x) => { x.value = Number((ev.target as HTMLInputElement).value) || 0; })} /></div>`;
    }
    if (kind === 'mode') {
      return this._modeRow(e);
    }
    // climate_temperature: temperature OR mode
    const asTemp = isTemp(e.value);
    return html`<div class="drow"><span class="dlabel">Value</span>
      <div class="seg">
        <button class=${asTemp ? 'on' : ''} @click=${() => { if (!asTemp) this._mutateSel((x) => { x.value = Math.round((this._scale().tmin + this._scale().tmax) / 2); }); }}>Temperature</button>
        <button class=${!asTemp ? 'on' : ''} @click=${() => { if (asTemp) this._mutateSel((x) => { x.value = this._modeOptions()[0] ?? 'off'; }); }}>Mode</button>
      </div></div>
      ${asTemp
        ? html`<div class="drow"><span class="dlabel"></span>
            <input class="num" type="number" .value=${String(e.value)}
              @change=${(ev: Event) => this._mutateSel((x) => { x.value = Math.round(Number((ev.target as HTMLInputElement).value) || 0); })} />
            <span class="hint">°${this._unit()}</span></div>`
        : this._modeRow(e)}`;
  }

  protected _modeRow(e: DayEntry) {
    const opts = this._modeOptions();
    const cur = String(e.value);
    const list = opts.includes(cur) ? opts : [cur, ...opts];
    return html`<div class="drow"><span class="dlabel"></span>
      <select class="sel" @change=${(ev: Event) => this._mutateSel((x) => { x.value = (ev.target as HTMLSelectElement).value; })}>
        ${list.map((o) => html`<option value=${o} ?selected=${o === cur}>${titleCase(o)}</option>`)}
      </select></div>`;
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
    .title h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
    .target { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; font-family: var(--code-font-family, monospace); }
    .now { margin-left: auto; text-align: right; }
    .now .cur { font-size: 22px; font-weight: 700; color: var(--primary-text-color); }
    .now .nxt { font-size: 12px; color: var(--secondary-text-color); }
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
    .foot { display: flex; gap: 10px; padding: 10px 16px 16px; border-top: 1px solid var(--divider-color); }
    button.act { font: inherit; font-weight: 600; font-size: 13px; border-radius: 8px; padding: 9px 13px; cursor: pointer;
      border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); }
  `;
}
function todayKey(): Weekday { return WEEKDAYS[(new Date().getDay() + 6) % 7]; }
function shortEntity(id: string): string { const p = id.split('.'); return p[p.length - 1]; }
