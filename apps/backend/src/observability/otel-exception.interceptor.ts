import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Exception, SpanStatusCode, trace } from '@opentelemetry/api';
import { type Observable, tap } from 'rxjs';

/** The HTTP status an exception maps to; anything that isn't an HttpException is a 500. */
export function statusFromException(err: unknown): number {
  return err instanceof HttpException ? err.getStatus() : 500;
}

/**
 * Record a server-side exception on the active OpenTelemetry span so it shows up **inside the
 * trace** — an exception event carrying type/message/stack, plus a red `ERROR` span status. That
 * turns "a span is red" into "here is the error and where it was thrown", which is the point of
 * keeping a distributed trace around for debugging.
 *
 * Only 5xx: a 4xx like a 401/404 is an expected response, not a fault, so marking its span as an
 * error would be misleading (and would make "0 errors on a 4xx" false). No-op when no span is
 * active — i.e. when OTel is disabled, or outside a request context — so it is always safe to call.
 */
export function recordExceptionOnActiveSpan(err: unknown): void {
  if (statusFromException(err) < 500) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  const exception: Exception = err instanceof Error ? err : { message: String(err) };
  span.recordException(exception);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Global interceptor that stamps any 5xx thrown by a handler/service onto the active request
 * span, then rethrows untouched so Nest's built-in exception layer formats the HTTP response
 * exactly as before. Registered via `APP_INTERCEPTOR` in `AppModule`.
 *
 * It observes only exceptions raised inside the handler pipeline (services, controllers). Errors
 * thrown by guards run before interceptors and are handled by Nest's exception filter directly —
 * those are the auth 4xx we intentionally don't mark anyway.
 */
@Injectable()
export class OtelExceptionInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(tap({ error: (err: unknown) => recordExceptionOnActiveSpan(err) }));
  }
}
