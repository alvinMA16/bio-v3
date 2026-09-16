import { Body, Controller, Optional, Get, Param, Post, Req, Res, NotFoundException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CompleteChatDto } from '../chat/dto/complete-chat.dto.js';
import { AgentService } from './agent.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { AgentStorage } from './agent-storage.js';

@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService, private readonly storage: AgentStorage, @Optional() private readonly memory?: MemoryService) {}

  @Get('manuscripts')
  async manuscripts(@Req() request: FastifyRequest) {
    const user = this.memory?.identity(request.headers.authorization);
    const items = user ? await this.memory!.manuscripts(user) : this.storage.localManuscripts();
    return items.map(({ conversationId, document }) => ({ conversationId, id: document.id, title: document.title, version: document.version }));
  }

  @Get('manuscripts/:conversationId/:documentId')
  async manuscript(@Param('conversationId') conversationId: string, @Param('documentId') documentId: string, @Req() request: FastifyRequest) {
    this.storage.assertId(conversationId);
    const user = this.memory?.identity(request.headers.authorization);
    const items = user ? await this.memory!.manuscripts(user, conversationId) : this.storage.localManuscripts();
    const item = items.find(item => item.conversationId === conversationId && item.document.id === documentId);
    if (!item) throw new NotFoundException('文稿不存在');
    return item.document;
  }

  @Get('runs/:runId/trace')
  async trace(@Param('runId') runId: string, @Req() request: FastifyRequest) {
    const user = this.memory?.identity(request.headers.authorization);
    if (user) await this.memory!.assertRun(user, runId);
    return this.storage.readTrace(runId);
  }

  /** POST + NDJSON supports fetch streams and mini-program chunked requests. */
  @Post('runs/stream')
  async stream(@Body() body: CompleteChatDto, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const user = this.memory?.identity(request.headers.authorization);
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort('connection_closed'); };
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
      const result = await this.agent.run(body, (event) => send({ kind: 'event', event }), controller.signal, user ? { userId: user } : undefined);
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
