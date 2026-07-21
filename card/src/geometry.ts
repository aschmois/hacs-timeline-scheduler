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
