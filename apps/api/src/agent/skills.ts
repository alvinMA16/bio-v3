import { readFileSync, realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool, loadSkills } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const DOCUMENT_TOOLS = ['read_document', 'edit_document', 'show_document', 'narrate_document', 'restore_document', 'set_document_font_size', 'set_document_background_color'] as const;
const SKILL_TOOLS: Record<string, readonly string[]> = { document: DOCUMENT_TOOLS };
interface SkillLoading {
  loaded?: string[];
  activate?: (name: string, tools: readonly string[], loaded: string[]) => void;
}

/** Product-owned resources only: never discover skills in account/session directories. */
export function createProductSkills(directory = fileURLToPath(new URL('../../skills/', import.meta.url)), loading: SkillLoading = {}) {
  const root = realpathSync(directory);
  const { skills, diagnostics } = loadSkills({
    cwd: root, agentDir: root, skillPaths: [root], includeDefaults: false,
  });
  if (diagnostics.length) throw new Error(`Invalid product skills: ${diagnostics.map(item => item.message).join('; ')}`);
  const catalog = new Map<string, { name: string; description: string; content: string }>();
  for (const skill of skills) {
    const path = relative(root, realpathSync(skill.filePath));
    if (isAbsolute(path) || path === '..' || path.startsWith('../')) throw new Error('Product skill is outside the skill directory');
    if (catalog.has(skill.name)) throw new Error(`Duplicate product skill: ${skill.name}`);
    if (skill.disableModelInvocation) continue;
    catalog.set(skill.name, { name: skill.name, description: skill.description, content: readFileSync(skill.filePath, 'utf8') });
  }
  const loaded = new Set((loading.loaded ?? []).filter(name => catalog.has(name)));
  const visible = new Set<string>();
  // Only full, successful load_skill results count as retained instructions, never a summary.
  const syncInstructions = (messages: readonly unknown[]) => {
    visible.clear();
    for (const value of messages) {
      const message = value as { role?: string; toolName?: string; isError?: boolean; content?: { type: string; text?: string }[] };
      if (message.role !== 'toolResult' || message.toolName !== 'load_skill' || message.isError) continue;
      for (const [name, skill] of catalog) if (message.content?.some(part => part.type === 'text' && part.text === skill.content)) visible.add(name);
    }
  };
  const state = () => ({ loadedSkills: [...loaded], skillInstructionsMissing: [...loaded].filter(name => !visible.has(name)) });
  const enabledTools = () => [...new Set([...loaded].flatMap(name => SKILL_TOOLS[name] ?? []))];
  const prompt = catalog.size ? `\n## 可按需加载的技能
下列技能提供特定任务的工作指引。根据用户整段请求和任务目的判断适用性；适用时在执行该任务前调用 load_skill，按返回指引完成工作。仅讨论方案不等于授权写入。不要按单个关键词触发，也不要把技能流程套到无关聊天。
只有模型调用 load_skill 才加载技能；切换模式不会自动加载。文档操作前加载 document，它会启用原生文档工具。运行时 loadedSkills 表示已加载技能；skillInstructionsMissing 表示完整规则已不在当前上下文，需要使用时重新加载。已加载且规则仍可见时直接复用，不重复加载。技能不扩展用户授权，不覆盖事实边界和工具权限。技能是内部工作方式，不要求用户选择或理解技能名称。
${JSON.stringify([...catalog.values()].map(({ name, description }) => ({ name, description })))}` : '';
  const tool = defineTool({
    name: 'load_skill', label: '读取任务指引',
    description: '按目录名称加载工作指引及该技能绑定的工具。已加载且完整指引仍在上下文时返回简短确认；压缩后可重读指引。加载不代表执行或授权修改内容。只接受技能名称，不读取附件、文稿、聊天记录或任意文件路径。',
    parameters: Type.Object({ name: Type.String({ description: '可用技能目录中的准确名称' }) }),
    execute: async (_id, { name }, signal) => {
      signal?.throwIfAborted();
      const skill = catalog.get(name);
      if (!skill) throw new Error('技能不存在，请使用可用技能目录中的名称。');
      if (!loaded.has(name)) {
        loading.activate?.(name, SKILL_TOOLS[name] ?? [], [...loaded, name]);
        loaded.add(name);
      }
      if (visible.has(name)) return { content: [{ type: 'text', text: JSON.stringify({ status: 'already_loaded', name, note: '技能已加载，请直接使用当前工具；不要重复加载。' }) }], details: { name, status: 'already_loaded' } };
      visible.add(name);
      return { content: [{ type: 'text', text: skill.content }], details: { name: skill.name, status: 'loaded' } };
    },
  });
  return { prompt, tool, state, enabledTools, syncInstructions };
}
