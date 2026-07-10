import { type Counter, metrics } from '@opentelemetry/api';

// The instrument is bound lazily on first record — NOT at module load. This module is
// imported (via AppModule) before bootstrap() calls startOtel(), so at import time the
// global MeterProvider is still the API no-op; an instrument created then would be
// permanently dead and never export. By the time a real login records, the SDK provider
// is installed. When OTel is disabled the meter is a no-op, so recording stays a safe,
// cheap no-op — call sites never guard on it. This is the pattern to copy for your own
// business metrics.
let loginAttempts: Counter | undefined;

function counter(): Counter {
  if (!loginAttempts) {
    loginAttempts = metrics.getMeter('app-backend').createCounter('auth.logins', {
      description: 'Login attempts, labelled by result (success | failure).',
    });
  }
  return loginAttempts;
}

/** Record one login attempt. `result` becomes a metric attribute/label. */
export function recordLoginAttempt(result: 'success' | 'failure'): void {
  counter().add(1, { result });
}
