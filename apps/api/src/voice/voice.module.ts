import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { VoiceGateway } from './voice.gateway.js';

@Module({ imports: [AgentModule], providers: [VoiceGateway] })
export class VoiceModule {}
