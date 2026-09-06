import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompleteChatDto } from '../chat/dto/complete-chat.dto.js';
import { AgentService } from './agent.service.js';
import { AgentStorage } from './agent-storage.js';

@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService, private readonly storage: AgentStorage) {}

  @Get('runs/:runId/trace')
  trace(@Param('runId') runId: string) { return this.storage.readTrace(runId); }

  /** POST + NDJSON supports fetch streams and mini-program chunked requests. */
  @Post('runs/stream')
  async stream(@Body() body: CompleteChatDto, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', disconnect);
    request.raw.on('aborted', disconnect);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
    });
    const send = (value: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(value)}\n`);
    };
    try {
      const result = await this.agent.run(body, (event) => send({ kind: 'event', event }), controller.signal);
      send({ kind: 'result', result });
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : 'Agent run failed' });
    } finally {
      reply.raw.off('close', disconnect);
      request.raw.off('aborted', disconnect);
      reply.raw.end();
    }
  }
}
