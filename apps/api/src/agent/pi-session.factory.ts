import { MaterialsService } from '../materials/materials.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { createMemoryTools } from '../memory/memory-tools.js';
import { MEMORY_RULES, type MemoryScope } from '../memory/memory-types.js';
import { CALL_HISTORY_RULES } from '../memory/call-history.js';
import { Injectable, Optional } from '@nestjs/common';
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
  constructor(private readonly config: ConfigService, private readonly storage: AgentStorage, private readonly materials: MaterialsService, @Optional() private readonly memory?: MemoryService) {}

  async create(conversationId: string, systemPrompt: string | undefined, emit: (event: AgentEventPayload) => void, provider?: ModelProvider, context?: AgentContextSnapshot, scope?: MemoryScope) {
    if (context?.materialIds?.length) {
      const attachments = await Promise.all(context.materialIds.map(id => this.materials.attachment(id)));
      context = { ...context, attachments: [...(context.attachments ?? []), ...attachments] };
    }
    const cwd = this.storage.conversationDirectory(conversationId, scope?.userId);
    const personaPath = join(cwd, 'persona.json');
    const persona = systemPrompt?.trim()
      || (existsSync(personaPath) ? JSON.parse(readFileSync(personaPath, 'utf8')) as string : DEFAULT_PERSONA);
    writeFileSync(personaPath, JSON.stringify(persona), { mode: 0o600 });

    const workspace = new PanelWorkspace(cwd, context?.attachments ?? []);
    emit({ type: 'panel.state.updated', panel: workspace.state() });

    const { modelRuntime, model } = await createModelRuntime(this.config, cwd, provider);

    const memoryContext = scope && this.memory?.enabled ? await this.memory.context(scope) : '';
    const memoryTools = scope && this.memory?.enabled ? createMemoryTools(this.memory, scope.userId) : [];
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => buildSystemPrompt(persona)
        + `\n当前能力：内容工具可用；长期记忆${memoryContext ? '已启用，依据下方概要与只读工具检索' : '未启用，没有跨通话检索工具；可以使用本通可见消息，但不能声称保存或记得上一通内容'}。`
        + (memoryContext ? `\n${MEMORY_RULES}\n${CALL_HISTORY_RULES}\n${memoryContext}` : ''),
      extensionFactories: [createContextExtension(() => buildRuntimeContext(context, workspace.context()))],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.open(join(cwd, 'session.jsonl'), cwd, cwd);
    const { session } = await createAgentSession({
      cwd, agentDir: cwd, modelRuntime, model, thinkingLevel: 'off',
      settingsManager, resourceLoader, sessionManager,
      tools: ['switch_mode', 'update_content', 'get_content', ...memoryTools.map(t => t.name)], customTools: [...createPresentationTools(workspace, emit), ...memoryTools],
    });
    return session;
  }
}
