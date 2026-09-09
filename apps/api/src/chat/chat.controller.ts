import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { ChatCompletionResponse } from '@bio/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChatService } from './chat.service.js';
import { CompleteChatDto } from './dto/complete-chat.dto.js';
import { SessionSummaryDto } from './dto/session-summary.dto.js';
import { SessionSummaryService } from './session-summary.service.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService, private readonly summaries: SessionSummaryService) {}

  @Post('session-summary')
  summarize(@Body() body: SessionSummaryDto) {
    return this.summaries.summarize(body);
  }

  @Post('completions')
  async complete(@Body() body: CompleteChatDto, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.on('aborted', disconnect);
    reply.raw.on('close', disconnect);
    try {
      return await this.chatService.complete(body.message, body.conversationId, body.systemPrompt, controller.signal, body.provider, body.context);
    } finally {
      request.raw.off('aborted', disconnect);
      reply.raw.off('close', disconnect);
    }
  }
}
