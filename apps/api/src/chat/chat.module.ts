import { Module } from '@nestjs/common';

import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { DeepSeekProvider } from './deepseek.provider';
import { MODEL_PROVIDER } from './model-provider';

@Module({
  controllers: [ChatController],
  providers: [
    ChatService,
    DeepSeekProvider,
    { provide: MODEL_PROVIDER, useExisting: DeepSeekProvider },
  ],
})
export class ChatModule {}
