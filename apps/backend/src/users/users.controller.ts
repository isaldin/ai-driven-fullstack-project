import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator.js';
import { ServiceTokenGuard } from '../auth/service-token.guard.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Service-to-service: consumed by the Telegram bot via the static machine token. */
  @Public()
  @UseGuards(ServiceTokenGuard)
  @ApiSecurity('service-token')
  @Get('count')
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    },
  })
  async count(): Promise<{ count: number }> {
    return { count: await this.users.count() };
  }
}
