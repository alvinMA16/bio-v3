import { Body, Controller, Optional, Post, Req, Res } from '@nestjs/common';
import type { ChatCompletionResponse } from '@bio/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MemoryService } from '../memory/memory.service.js';
import { ChatService } from './chat.service.js';
import { CompleteChatDto } from './dto/complete-chat.dto.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService, @Optional() private readonly memory?: MemoryService) {}

  @Post('completions')
  async complete(@Body() body: CompleteChatDto, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<ChatCompletionResponse> {
    const user = await this.memory?.resolveIdentity(request.headers.authorization);
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.on('aborted', disconnect);
    reply.raw.on('close', disconnect);
    try {
      return await this.chatService.complete(body.message, body.conversationId, body.systemPrompt, controller.signal, body.provider, body.context, user);
    } finally {
      request.raw.off('aborted', disconnect);
      reply.raw.off('close', disconnect);
    }
  }
}
