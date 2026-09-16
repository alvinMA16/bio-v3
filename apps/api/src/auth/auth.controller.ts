import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Matches } from 'class-validator';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService, SESSION_SECONDS } from './auth.service.js';
class PhoneDto { @Matches(/^1[3-9]\d{9}$/, { message: '请输入正确的中国大陆手机号' }) phone!: string; }
class LoginDto extends PhoneDto { @Matches(/^\d{6}$/, { message: '请输入六位验证码' }) code!: string; }
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}
  @Get('config') configPublic() { return { enabled: this.auth.enabled }; }
  @Post('code') code(@Body() body: PhoneDto, @Req() req: FastifyRequest) { return this.auth.sendCode(body.phone, req.ip); }
  @Post('login') async login(@Body() body: LoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.login(body.phone, body.code);
    reply.header('Cache-Control', 'no-store').header('Set-Cookie', this.cookie(result.token, SESSION_SECONDS));
    return result;
  }
  @Get('me') me(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) { reply.header('Cache-Control', 'no-store'); return this.auth.me(req.headers.authorization); }
  @Post('logout') async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.logout(req.headers.authorization);
    reply.header('Set-Cookie', this.cookie('', 0)); return result;
  }
  private cookie(token: string, maxAge: number) {
    // Cookie is used only for read-only original-file URLs. All other APIs use Bearer.
    return `bio-file-session=${token}; Path=/api/v1/materials; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.config.get('NODE_ENV') === 'production' ? '; Secure' : ''}`;
  }
}
