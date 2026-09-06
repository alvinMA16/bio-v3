import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEventPayload } from '@bio/contracts';

import { AgentStorage } from './agent-storage.js';
import { createPresentationTools } from './presentation-tools.js';
import { createModelRuntime } from '../models/model-provider.js';
import type { ModelProvider } from '@bio/contracts';

const DEFAULT_PERSONA = '你是 Bio，一个清晰、可靠、自然亲切的助手。帮助用户对话、整理内容和完成任务。';
const PRESENTATION_RULES = `\n面向用户的普通回复用于人物字幕，也可能被语音播报，表达应简洁自然。
长文章、清单等完整内容使用 show_panel 展示，随后简短说明。
只有工具明确确认的操作才可以宣称完成。show_panel 只展示内容，不保存文章。
当前尚未接入语音播放、长期记忆或文章编辑存储，不要宣称已执行这些能力。`;

@Injectable()
export class PiSessionFactory {
  constructor(private readonly config: ConfigService, private readonly storage: AgentStorage) {}

  async create(conversationId: string, systemPrompt: string | undefined, emit: (event: AgentEventPayload) => void, provider?: ModelProvider) {
    const cwd = this.storage.conversationDirectory(conversationId);
    const personaPath = join(cwd, 'persona.json');
    const persona = systemPrompt?.trim()
      || (existsSync(personaPath) ? JSON.parse(readFileSync(personaPath, 'utf8')) as string : DEFAULT_PERSONA);
    writeFileSync(personaPath, JSON.stringify(persona), { mode: 0o600 });

    const { modelRuntime, model } = await createModelRuntime(this.config, cwd, provider);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => persona + PRESENTATION_RULES,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.open(join(cwd, 'session.jsonl'), cwd, cwd);
    const { session } = await createAgentSession({
      cwd, agentDir: cwd, modelRuntime, model, thinkingLevel: 'off',
      settingsManager, resourceLoader, sessionManager,
      tools: ['show_panel'], customTools: createPresentationTools(emit),
    });
    return session;
  }
}
