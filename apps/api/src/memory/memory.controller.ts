import { Controller, Get, Post, Param, Req, NotFoundException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MemoryService } from './memory.service.js';
@Controller('memory')
export class MemoryController {
  constructor(private memory: MemoryService) {}
  private user(req: FastifyRequest): string { const user = this.memory.identity(req.headers.authorization); if (!user) throw new NotFoundException('Memory disabled'); return user; }
  @Get('overview') async overview(@Req() req: FastifyRequest) { return this.memory.overview(this.user(req)); }
  @Get('jobs') async jobs(@Req() req: FastifyRequest) {
    const user = this.user(req);
    return (await this.memory.pool!.query('SELECT call_id,status,attempts,error,created_at,finished_at FROM bio_memory_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [user])).rows;
  }
  @Post('jobs/:callId/retry') async retry(@Param('callId') callId: string, @Req() req: FastifyRequest) {
    const user = this.user(req);
    const result = await this.memory.pool!.query("UPDATE bio_memory_jobs SET status='pending',attempts=0,available_at=now(),error=NULL WHERE user_id=$1 AND call_id=$2 AND status='failed' RETURNING call_id", [user, callId]);
    if (!result.rowCount) throw new NotFoundException('Failed job not found'); return { queued: true };
  }
}
