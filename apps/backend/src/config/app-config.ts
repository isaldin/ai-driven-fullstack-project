import { type Env, loadEnv } from '@app/config';
import { Injectable } from '@nestjs/common';

/** Validated, typed application configuration (fails fast on invalid env). */
@Injectable()
export class AppConfig {
  readonly env: Env;

  constructor() {
    this.env = loadEnv();
  }
}
