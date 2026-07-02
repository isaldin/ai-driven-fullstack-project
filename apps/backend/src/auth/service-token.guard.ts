import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig } from '../config/app-config.js';
import type { AuthUser } from './types.js';

/** Guards service-to-service routes: validates the static machine token from the bot. */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = request.headers['x-service-token'];
    if (!token || token !== this.config.env.SERVICE_API_TOKEN) {
      throw new UnauthorizedException('Invalid service token');
    }
    request.user = { id: 'service', email: 'service@internal', role: 'SERVICE' };
    return true;
  }
}
