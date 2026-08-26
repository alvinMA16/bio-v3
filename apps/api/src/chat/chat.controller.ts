import { Body, Controller, Post } from '@nestjs/common';
import type { ChatCompletionResponse } from '@bio/contracts';

import { ChatService } from './chat.service';
import { CompleteChatDto } from './dto/complete-chat.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('completions')
  complete(@Body() body: CompleteChatDto): Promise<ChatCompletionResponse> {
    return this.chatService.complete(
      body.message,
      body.conversationId,
      body.systemPrompt,
    );
  }
}
