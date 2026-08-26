import { Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ChatService } from './chat.service';
import { StreamChatDto } from './dto/stream-chat.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('stream')
  async stream(
    body: StreamChatDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('X-Accel-Buffering', 'no');

    const abortController = new AbortController();
    reply.raw.on('close', () => abortController.abort());

    try {
      for await (const event of this.chatService.stream(
        body.message,
        body.conversationId,
        abortController.signal,
      )) {
        reply.raw.write(`${JSON.stringify(event)}\n`);
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        reply.raw.write(
          `${JSON.stringify({
            type: 'error',
            code: 'MODEL_REQUEST_FAILED',
            message: error instanceof Error ? error.message : 'Unknown error',
          })}\n`,
        );
      }
    } finally {
      reply.raw.end();
    }
  }
}
