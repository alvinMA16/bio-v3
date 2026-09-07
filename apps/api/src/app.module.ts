import { VoiceModule } from './voice/voice.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ChatModule } from './chat/chat.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    ChatModule,
    VoiceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
