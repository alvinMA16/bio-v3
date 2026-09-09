import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { SessionSummaryService } from './session-summary.service.js';

@Module({
  imports: [AgentModule],
  controllers: [ChatController],
  providers: [ChatService, SessionSummaryService],
})
export class ChatModule {}
