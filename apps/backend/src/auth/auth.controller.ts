import {
  type LoginInput,
  loginSchema,
  type MessageResponse,
  messageResponseSchema,
  type RegisterInput,
  registerSchema,
  type Tokens,
  tokensSchema,
  type UserDto,
  userDtoSchema,
} from '@app/contracts';
import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { openApiSchema } from '../common/openapi.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AppConfig } from '../config/app-config.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { Public } from './public.decorator.js';
import type { AuthUser } from './types.js';

const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/auth';

/** Tight per-IP limit on the unauthenticated auth endpoints to blunt brute-force. */
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  @ApiBody({ schema: openApiSchema(registerSchema) })
  @ApiCreatedResponse({ schema: openApiSchema(userDtoSchema) })
  register(@Body(new ZodValidationPipe(registerSchema)) dto: RegisterInput): Promise<UserDto> {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @ApiBody({ schema: openApiSchema(loginSchema) })
  @ApiOkResponse({ schema: openApiSchema(tokensSchema) })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Tokens> {
    const { accessToken, refreshToken } = await this.auth.login(dto);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @ApiOkResponse({ schema: openApiSchema(tokensSchema) })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<Tokens> {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    const { accessToken, refreshToken } = await this.auth.refresh(raw);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken };
  }

  @ApiBearerAuth()
  @Post('logout')
  @ApiOkResponse({ schema: openApiSchema(messageResponseSchema) })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageResponse> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
    return { message: 'Logged out' };
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOkResponse({ schema: openApiSchema(userDtoSchema) })
  me(@CurrentUser() user: AuthUser): Promise<UserDto> {
    return this.auth.me(user.id);
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.env.NODE_ENV === 'production',
      sameSite: 'lax',
      domain: this.config.env.COOKIE_DOMAIN,
      path: REFRESH_PATH,
      maxAge: this.config.env.JWT_REFRESH_TTL * 1000,
    });
  }
}
