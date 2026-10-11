import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AgentModule } from '../agent/agent.module.js';
import { MaterialsModule } from '../materials/materials.module.js';
import { AdminService } from './admin.service.js';
import { AdminGuard } from './admin.guard.js';
import { AdminController } from './admin.controller.js';

@Module({ imports: [AuthModule, AgentModule, MaterialsModule], providers: [AdminService, AdminGuard], controllers: [AdminController] })
export class AdminModule {}
