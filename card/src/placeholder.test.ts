import { describe, it, expect } from 'vitest';
describe('scaffold', () => {
  it('imports the card module and registers the element', async () => {
    await import('./index');
    expect(customElements.get('timeline-scheduler-card')).toBeTruthy();
  });
});
