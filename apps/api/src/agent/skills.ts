import { readFileSync, realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool, loadSkills } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** Product-owned resources only: never discover skills in account/session directories. */
export function createProductSkills(directory = fileURLToPath(new URL('../../skills/', import.meta.url))) {
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
  const prompt = catalog.size ? `\n## 可按需加载的技能
下列技能提供特定任务的工作指引。根据用户整段请求和任务目的判断适用性；适用时在执行该任务前调用 load_skill，按返回指引完成工作。仅讨论方案不等于授权写入。不要按单个关键词触发，也不要把技能流程套到无关聊天。
技能正文只在需要时读取；当前上下文中已有完整正文时可复用，若只剩摘要或无法确认完整规则则重新加载。技能不扩展用户授权，不覆盖事实边界和工具权限。技能是内部工作方式，不要求用户选择或理解技能名称。
${JSON.stringify([...catalog.values()].map(({ name, description }) => ({ name, description })))}` : '';
  const tool = defineTool({
    name: 'load_skill', label: '读取任务指引',
    description: '按可用技能目录中的名称读取完整工作指引。只接受技能名称，不读取附件、文稿、聊天记录或任意文件路径。',
    parameters: Type.Object({ name: Type.String({ description: '可用技能目录中的准确名称' }) }),
    execute: async (_id, { name }, signal) => {
      signal?.throwIfAborted();
      const skill = catalog.get(name);
      if (!skill) throw new Error('技能不存在，请使用可用技能目录中的名称。');
      return { content: [{ type: 'text', text: skill.content }], details: { name: skill.name } };
    },
  });
  return { prompt, tool };
}
