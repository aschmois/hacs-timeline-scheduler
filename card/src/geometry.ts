import type { TempUnit } from './types';

// Plot geometry in viewBox units. The viewBox is kept close to the real render
// width (~500) so 1 unit ≈ 1 CSS px — text and dots don't get scaled down (a
// 1000-wide viewBox halved everything on a single-column card).
export const plot = { L: 38, R: 488, T: 16, B: 186, mode: 222, axis: 248 };
const W = plot.R - plot.L, H = plot.B - plot.T;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface Scale { unit: TempUnit; tmin: number; tmax: number; }
export const DEFAULT_RANGE: Record<TempUnit, [number, number]> = { C: [10, 43], F: [50, 110] };
export const gridStep = (unit: TempUnit) => (unit === 'C' ? 5 : 10);

/** Build a temperature scale for `unit`, widened to include any out-of-range values. */
export function makeScale(unit: TempUnit, values: number[] = []): Scale {
  let [tmin, tmax] = DEFAULT_RANGE[unit];
  const step = gridStep(unit);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < tmin) tmin = Math.floor(v / step) * step;
    if (v > tmax) tmax = Math.ceil(v / step) * step;
  }
  return { unit, tmin, tmax };
}

export const xOfMin = (m: number) => plot.L + (m / 1440) * W;
export const minOfX = (px: number) => ((px - plot.L) / W) * 1440;
export const yOfTemp = (t: number, s: Scale) =>
  plot.B - ((clamp(t, s.tmin, s.tmax) - s.tmin) / (s.tmax - s.tmin)) * H;
export const tempOfY = (py: number, s: Scale) =>
  s.tmin + ((plot.B - py) / H) * (s.tmax - s.tmin);

/** Cold→hot color, keyed to the value's position within the scale (unit-agnostic). */
export function tempColor(t: number, s: Scale): string {
  const u = clamp((t - s.tmin) / (s.tmax - s.tmin), 0, 1);
  const stops: [number, [number, number, number]][] =
    [[0, [74, 144, 217]], [0.55, [239, 177, 90]], [1, [226, 96, 63]]];
  if (u <= stops[0][0]) return rgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i][0]) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i], k = (u - a0) / (a1 - a0);
      return rgb([lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)]);
    }
  }
  return rgb(stops[stops.length - 1][1]);
}
const rgb = (c: number[]) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;
