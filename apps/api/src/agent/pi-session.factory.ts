import { MaterialsService } from '../materials/materials.service.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEventPayload } from '@bio/contracts';

import { PanelWorkspace } from './panel-workspace.js';
import { AgentStorage } from './agent-storage.js';
import { createPresentationTools } from './presentation-tools.js';
import { createModelRuntime } from '../models/model-provider.js';
import { buildRuntimeContext, buildSystemPrompt, createContextExtension, DEFAULT_PERSONA } from './agent-context.js';
import type { AgentContextSnapshot, ModelProvider } from '@bio/contracts';

@Injectable()
export class PiSessionFactory {
  constructor(private readonly config: ConfigService, private readonly storage: AgentStorage, private readonly materials: MaterialsService) {}

  async create(conversationId: string, systemPrompt: string | undefined, emit: (event: AgentEventPayload) => void, provider?: ModelProvider, context?: AgentContextSnapshot) {
    if (context?.materialIds?.length) {
      const attachments = await Promise.all(context.materialIds.map(id => this.materials.attachment(id)));
      context = { ...context, attachments: [...(context.attachments ?? []), ...attachments] };
    }
    const cwd = this.storage.conversationDirectory(conversationId);
    const personaPath = join(cwd, 'persona.json');
    const persona = systemPrompt?.trim()
      || (existsSync(personaPath) ? JSON.parse(readFileSync(personaPath, 'utf8')) as string : DEFAULT_PERSONA);
    writeFileSync(personaPath, JSON.stringify(persona), { mode: 0o600 });

    const workspace = new PanelWorkspace(cwd, context?.attachments ?? []);
    emit({ type: 'panel.state.updated', panel: workspace.state() });

    const { modelRuntime, model } = await createModelRuntime(this.config, cwd, provider);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => buildSystemPrompt(persona),
      extensionFactories: [createContextExtension(() => buildRuntimeContext(context, workspace.context()))],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.open(join(cwd, 'session.jsonl'), cwd, cwd);
    const { session } = await createAgentSession({
      cwd, agentDir: cwd, modelRuntime, model, thinkingLevel: 'off',
      settingsManager, resourceLoader, sessionManager,
      tools: ['switch_mode', 'update_content', 'get_content'], customTools: createPresentationTools(workspace, emit),
    });
    return session;
  }
}
