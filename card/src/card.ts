import { LitElement, html, css, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HassLike, Schedule, Weekday, SetVal } from './types';
import { WEEKDAYS } from './types';
import { getSchedule, saveSchedule } from './api';
import { expandByDay, daySegments, resolveMin, fmtMin, collapseToTransitions, DayEntry } from './schedule';
import { plot, xOfMin, yOfTemp, tempColor, minOfX, tempOfY } from './geometry';

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
      this._wireDot(grp as SVGGElement, e);
    }
  }
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
      <button class="rm" title="Remove" @click=${(ev: Event) => { ev.stopPropagation(); this._remove(e.id); }}>×</button>
    </div>`;
  }
  protected _footer() {
    return html`<div class="foot">
      <button class="act" @click=${() => this._addSetpoint()}>＋ Add setpoint</button>
      <button class="act save" ?disabled=${!this._dirty} @click=${() => this._save()}>Save schedule</button>
    </div>`;
  }

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
    .rm{margin-left:6px;border:none;background:transparent;color:var(--secondary-text-color);cursor:pointer;font-size:15px;border-radius:6px;width:24px;height:24px}.rm:hover{color:var(--error-color,#e06)}
    :host { --tsc-off: #6b7280; }
    .foot { display: flex; gap: 10px; padding: 10px 16px 16px; border-top: 1px solid var(--divider-color); }
    button.act { font: inherit; font-weight: 600; font-size: 13px; border-radius: 8px; padding: 9px 13px; cursor: pointer;
      border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); }
    button.save { margin-left: auto; background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
    button[disabled] { opacity: .5; cursor: default; }
  `;
}
function todayKey(): Weekday { return WEEKDAYS[(new Date().getDay() + 6) % 7]; }
