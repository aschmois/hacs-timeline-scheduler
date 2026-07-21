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
