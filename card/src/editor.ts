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
