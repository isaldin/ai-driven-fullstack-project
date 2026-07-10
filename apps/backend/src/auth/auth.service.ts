import { randomBytes } from 'node:crypto';
import type { RegisterInput, UserDto } from '@app/contracts';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import { recordLoginAttempt } from '../observability/metrics.js';
import type { AuthUser } from './types.js';

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  async register(input: RegisterInput): Promise<UserDto> {
    const existing = await this.db.client.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(input.password);
    const user = await this.db.client.user.create({
      data: { email: input.email, name: input.name ?? null, passwordHash },
    });
    return this.toDto(user);
  }

  async validateUser(email: string, password: string): Promise<AuthUser> {
    const user = await this.db.client.user.findUnique({ where: { email } });
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return { id: user.id, email: user.email, role: user.role };
  }

  async login(input: { email: string; password: string }): Promise<IssuedTokens> {
    let user: AuthUser;
    try {
      user = await this.validateUser(input.email, input.password);
    } catch (err) {
      recordLoginAttempt('failure');
      throw err;
    }
    recordLoginAttempt('success');
    // Structured app log emitted inside the request span — the trace-context mixin
    // stamps trace_id/span_id, so this line correlates with its trace in OpenObserve.
    this.logger.info({ userId: user.id }, 'login succeeded');
    return this.issueTokens(user);
  }

  async refresh(rawToken: string | undefined): Promise<IssuedTokens> {
    const parsed = this.parseRefreshToken(rawToken);
    if (!parsed) throw new UnauthorizedException('Missing refresh token');

    const record = await this.db.client.refreshToken.findUnique({ where: { id: parsed.id } });
    if (
      !record ||
      record.revokedAt ||
      record.expiresAt.getTime() < Date.now() ||
      !(await argon2.verify(record.tokenHash, parsed.secret))
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Revoke conditionally and gate on the affected count so two concurrent requests
    // bearing the same refresh token cannot both pass the check above and both mint a
    // new pair (rotation double-spend / TOCTOU). The loser matches 0 rows -> reject.
    const revoked = await this.db.client.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new UnauthorizedException('Invalid refresh token');

    const user = await this.db.client.user.findUnique({ where: { id: record.userId } });
    if (!user) throw new UnauthorizedException('Invalid refresh token');
    return this.issueTokens({ id: user.id, email: user.email, role: user.role });
  }

  async logout(rawToken: string | undefined): Promise<void> {
    const parsed = this.parseRefreshToken(rawToken);
    if (!parsed) return;
    await this.db.client.refreshToken.updateMany({
      where: { id: parsed.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<UserDto> {
    const user = await this.db.client.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return this.toDto(user);
  }

  private async issueTokens(user: AuthUser): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      { secret: this.config.env.JWT_ACCESS_SECRET, expiresIn: this.config.env.JWT_ACCESS_TTL },
    );

    const secret = randomBytes(32).toString('hex');
    const tokenHash = await argon2.hash(secret);
    const expiresAt = new Date(Date.now() + this.config.env.JWT_REFRESH_TTL * 1000);
    const record = await this.db.client.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    return { accessToken, refreshToken: `${record.id}.${secret}` };
  }

  private parseRefreshToken(raw: string | undefined): { id: string; secret: string } | null {
    if (!raw) return null;
    const idx = raw.indexOf('.');
    if (idx <= 0) return null;
    return { id: raw.slice(0, idx), secret: raw.slice(idx + 1) };
  }

  private toDto(user: {
    id: string;
    email: string;
    name: string | null;
    role: UserDto['role'];
    createdAt: Date;
  }): UserDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
