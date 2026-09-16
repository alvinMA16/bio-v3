import { Controller, Get, Optional } from '@nestjs/common';
import { MemoryService } from '../memory/memory.service.js';

@Controller('health')
export class HealthController {
  constructor(@Optional() private readonly memory?: MemoryService) {}
  @Get()
  getHealth() {
    return { status: 'ok', timestamp: new Date().toISOString(), capabilities: { memory: this.memory?.enabled ?? false } };
  }
}
