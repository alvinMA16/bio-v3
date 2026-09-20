import { MaterialsModule } from '../materials/materials.module.js';
import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller.js';
import { AgentService } from './agent.service.js';
import { AgentStorage } from './agent-storage.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { DocumentStore } from './document-store.js';

@Module({
  imports: [MaterialsModule],
  controllers: [AgentController],
  providers: [AgentService, AgentStorage, PiSessionFactory, DocumentStore],
  exports: [AgentService],
})
export class AgentModule {}
