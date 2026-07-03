import { Injectable, Logger } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(
    private readonly health: HealthIndicatorService,
    private readonly db: DatabaseService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    try {
      await this.db.ping();
      return indicator.up();
    } catch (error) {
      // `/health/ready` is public: log the real cause server-side, but return a
      // static message so a raw `pg` error (host/port, ECONNREFUSED) isn't leaked.
      this.logger.error(
        `Database readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return indicator.down({ message: 'database unreachable' });
    }
  }
}
