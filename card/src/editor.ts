import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HassLike, CardConfig, Schedule } from './types';
import { listSchedules } from './api';

@customElement('timeline-scheduler-card-editor')
export class TimelineSchedulerCardEditor extends LitElement {
  @property({ attribute: false }) public hass?: HassLike;
  @state() private _config: CardConfig = {};
  @state() private _schedules?: Schedule[];

  public setConfig(config: CardConfig): void { this._config = { ...config }; }

  protected willUpdate(): void {
    if (this.hass && this._schedules === undefined) {
      this._schedules = [];
      listSchedules(this.hass).then((s) => { this._schedules = s; }).catch(() => { this._schedules = []; });
    }
  }

  private _set(field: keyof CardConfig, value: unknown): void {
    this._config = { ...this._config, [field]: value };
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  render() {
    const schedules = this._schedules ?? [];
    const scheduleSelector = {
      select: {
        mode: 'dropdown', custom_value: true,
        options: schedules.map((s) => ({ value: s.id, label: s.name || s.id })),
      },
    };
    const unitSelector = {
      select: {
        mode: 'dropdown',
        options: [
          { value: 'auto', label: 'Follow Home Assistant' },
          { value: 'C', label: 'Celsius (°C)' },
          { value: 'F', label: 'Fahrenheit (°F)' },
        ],
      },
    };
    return html`<div class="f">
      <ha-selector .hass=${this.hass} .selector=${scheduleSelector} label="Schedule"
        .value=${this._config.schedule_id ?? ''} @value-changed=${(e: any) => this._set('schedule_id', e.detail.value)}></ha-selector>
      <ha-selector .hass=${this.hass} .selector=${unitSelector} label="Temperature unit"
        .value=${this._config.unit ?? 'auto'} @value-changed=${(e: any) => this._set('unit', e.detail.value)}></ha-selector>
      <ha-selector .hass=${this.hass} .selector=${{ text: {} }} label="Title (optional)"
        .value=${this._config.name ?? ''} @value-changed=${(e: any) => this._set('name', e.detail.value)}></ha-selector>
    </div>`;
  }

  static styles = css`.f { display: flex; flex-direction: column; gap: 16px; padding: 8px 0; }`;
}
