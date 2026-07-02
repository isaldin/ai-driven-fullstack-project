import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ZenStackClient } from '@zenstackhq/orm';
import { PostgresDialect } from '@zenstackhq/orm/dialects/postgres';
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

  constructor(config: AppConfig) {
    this.pool = new Pool({ connectionString: config.env.DATABASE_URL });
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
