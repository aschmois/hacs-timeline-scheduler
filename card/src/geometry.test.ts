import { describe, it, expect } from 'vitest';
import { tempColor, xOfMin, yOfTemp, minOfX, tempOfY, makeScale, DEFAULT_RANGE } from './geometry';

const F = makeScale('F');

describe('geometry', () => {
  it('tempColor returns rgb and warms with temperature', () => {
    expect(tempColor(F.tmin, F)).toMatch(/^rgb\(/);
    const cool = tempColor(60, F), hot = tempColor(108, F);
    const r = (s: string) => Number(s.slice(4, -1).split(',')[0]);
    expect(r(hot)).toBeGreaterThan(r(cool)); // more red when hotter
  });
  it('min<->x and temp<->y round-trip', () => {
    expect(Math.round(minOfX(xOfMin(600)))).toBe(600);
    expect(Math.round(tempOfY(yOfTemp(80, F), F))).toBe(80);
    expect(yOfTemp(F.tmax, F)).toBeLessThan(yOfTemp(F.tmin, F)); // hotter is higher
  });
  it('makeScale uses per-unit defaults and widens to fit out-of-range values', () => {
    expect([makeScale('C').tmin, makeScale('C').tmax]).toEqual(DEFAULT_RANGE.C);
    expect(makeScale('F', [120]).tmax).toBeGreaterThanOrEqual(120);
    expect(makeScale('C', [-5]).tmin).toBeLessThanOrEqual(-5);
  });
  it('makeScale honors device bounds and still widens for out-of-range setpoints', () => {
    expect([makeScale('F', [], { min: 55, max: 118 }).tmin, makeScale('F', [], { min: 55, max: 118 }).tmax]).toEqual([55, 118]);
    expect(makeScale('F', [130], { min: 55, max: 118 }).tmax).toBeGreaterThanOrEqual(130);
    expect(makeScale('F', [], { min: 100, max: 50 }).tmin).toBe(DEFAULT_RANGE.F[0]); // invalid bounds ignored
  });
});
