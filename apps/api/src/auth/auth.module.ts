import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { SmsService } from './sms.service.js';
@Global()
@Module({ providers: [AuthService, SmsService], controllers: [AuthController], exports: [AuthService] })
export class AuthModule {}
