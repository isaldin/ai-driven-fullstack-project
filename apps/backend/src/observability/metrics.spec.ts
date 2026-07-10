import { describe, expect, it } from 'vitest';
import { recordLoginAttempt } from './metrics.js';

// With no OTel SDK started in the test process, the metrics API returns a no-op meter.
// Recording must stay safe (and cheap) in that state — call sites never guard on it.
describe('recordLoginAttempt', () => {
  it('is a no-op-safe call when OTel is not started', () => {
    expect(() => recordLoginAttempt('success')).not.toThrow();
    expect(() => recordLoginAttempt('failure')).not.toThrow();
  });
});
