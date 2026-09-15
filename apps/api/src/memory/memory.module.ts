import { Global, Module } from '@nestjs/common';
import { MemoryService } from './memory.service.js';
import { MemoryWorker } from './memory-worker.js';
import { MemoryController } from './memory.controller.js';
@Global()
@Module({ providers: [MemoryService, MemoryWorker], controllers: [MemoryController], exports: [MemoryService] })
export class MemoryModule {}
