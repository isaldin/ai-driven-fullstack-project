import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  count(): Promise<number> {
    return this.db.client.user.count();
  }
}
