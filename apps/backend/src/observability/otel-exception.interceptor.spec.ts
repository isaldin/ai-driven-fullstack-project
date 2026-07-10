import {
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { recordExceptionOnActiveSpan, statusFromException } from './otel-exception.interceptor.js';

describe('statusFromException', () => {
  it('reads the status off an HttpException', () => {
    expect(statusFromException(new BadRequestException())).toBe(400);
    expect(statusFromException(new UnauthorizedException())).toBe(401);
    expect(statusFromException(new InternalServerErrorException())).toBe(500);
    expect(statusFromException(new ServiceUnavailableException())).toBe(503);
  });

  it('treats anything that is not an HttpException as a 500', () => {
    expect(statusFromException(new Error('boom'))).toBe(500);
    expect(statusFromException('a thrown string')).toBe(500);
    expect(statusFromException(undefined)).toBe(500);
  });
});

describe('recordExceptionOnActiveSpan', () => {
  // No context manager is registered here, so there is never an active span: every call must be
  // a safe no-op regardless of the error's status. (The real span recording is exercised
  // end-to-end against a running backend with OTel on — see docs/OBSERVABILITY.md.)
  it('never throws whether the error is a 5xx, a 4xx, or a non-Error', () => {
    expect(() =>
      recordExceptionOnActiveSpan(new InternalServerErrorException('db down')),
    ).not.toThrow();
    expect(() => recordExceptionOnActiveSpan(new UnauthorizedException())).not.toThrow();
    expect(() => recordExceptionOnActiveSpan('weird')).not.toThrow();
  });
});
