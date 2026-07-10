import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ZenStackClient } from '@zenstackhq/orm';
import { PostgresDialect } from '@zenstackhq/orm/dialects/postgres';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { AppConfig } from '../config/app-config.js';
import { schema } from '../zenstack/schema.js';

function createClient(pool: Pool) {
  return new ZenStackClient(schema, { dialect: new PostgresDialect({ pool }) });
}

/** The ZenStack v3 client type, inferred from the generated schema. */
export type AppDb = ReturnType<typeof createClient>;

/**
 * Owns the pg pool and the ZenStack client. Trusted NestJS services use this
 * client directly (the curated REST controllers are the security boundary).
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  readonly client: AppDb;

  constructor(
    config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DatabaseService.name);
    this.pool = new Pool({ connectionString: config.env.DATABASE_URL });
    // node-postgres emits 'error' on an *idle* pooled client when the backend or network
    // drops (e.g. Postgres restarts). With no listener Node treats it as an unhandled error
    // and crashes the process — a transient DB blip would take the whole API down instead of
    // surfacing as 5xx. Log it and let the pool discard the dead client and reconnect on the
    // next query. In-flight queries still reject and are recorded on their trace span (see
    // observability/otel-exception.interceptor.ts).
    this.pool.on('error', (err) => {
      this.logger.error({ err }, 'Idle Postgres client error — pool will reconnect');
    });
    this.client = createClient(this.pool);
  }

  /** Liveness probe for the readiness health check. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
