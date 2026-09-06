import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentEventPayload } from '@bio/contracts';

export function createPresentationTools(emit: (event: AgentEventPayload) => void) {
  return [defineTool({
    name: 'show_panel',
    label: '展示工作面板',
    description: '在用户的工作面板展示 Markdown 内容。相同 panelId 更新同一面板。内容仅用于展示，不代表文章已保存。',
    parameters: Type.Object({
      panelId: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' }),
      title: Type.String({ minLength: 1, maxLength: 120 }),
      content: Type.String({ minLength: 1, maxLength: 40000 }),
    }),
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      emit({ type: 'panel.updated', panel: {
        id: params.panelId, type: 'markdown', title: params.title, content: params.content,
      } });
      return {
        content: [{ type: 'text' as const, text: '面板更新事件已生成。未保存为文章，也未确认客户端已展示。' }],
        details: { panelId: params.panelId },
      };
    },
  })];
}
