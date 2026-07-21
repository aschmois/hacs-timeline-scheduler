import './card';
(window as unknown as { customCards?: unknown[] }).customCards ??= [];
(window as unknown as { customCards: unknown[] }).customCards.push({
  type: 'timeline-scheduler-card',
  name: 'Timeline Scheduler Card',
  description: 'Nest-style per-day setpoint timeline editor.',
});
