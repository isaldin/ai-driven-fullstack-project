import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import passportJwt from 'passport-jwt';
import { AppConfig } from '../config/app-config.js';
import type { AuthUser, JwtPayload } from './types.js';

const { Strategy, ExtractJwt } = passportJwt;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: AppConfig) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.env.JWT_ACCESS_SECRET,
    });
  }

  validate(payload: JwtPayload): AuthUser {
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
