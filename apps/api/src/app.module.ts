import { AuthModule } from './auth/auth.module.js';
import { MemoryModule } from './memory/memory.module.js';
import { VoiceModule } from './voice/voice.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ChatModule } from './chat/chat.module.js';
import { HealthController } from './health/health.controller.js';
import { AssetsController } from './assets/assets.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    AuthModule,
    MemoryModule,
    ChatModule,
    VoiceModule,
  ],
  controllers: [HealthController, AssetsController],
})
export class AppModule {}
