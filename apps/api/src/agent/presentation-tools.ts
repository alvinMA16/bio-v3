import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { AgentEventPayload, PanelState } from '@bio/contracts';
import { PanelWorkspace } from './panel-workspace.js';

const id = Type.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' });
const block = Type.Object({
  id,
  kind: Type.Union(['paragraph', 'heading', 'list', 'quote', 'code'].map(value => Type.Literal(value))),
  text: Type.String({ maxLength: 12000 }),
});

export function createPresentationTools(workspace: PanelWorkspace, emit: (event: AgentEventPayload) => void) {
  const updated = (panel: PanelState) => {
    emit({ type: 'panel.state.updated', panel });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        status: 'persisted_locally', rendered: false,
        mode: panel.mode, revision: panel.revision,
        document: panel.document && {
          id: panel.document.id, title: panel.document.title, version: panel.document.version,
          blockIds: panel.document.blocks.map(item => item.id),
        },
        attachmentId: panel.attachment?.id,
        note: '面板状态已在本地会话保存，已生成更新事件；未确认客户端渲染，未发布文章或修改附件原件。',
      }) }],
      details: { revision: panel.revision },
    };
  };
  return [
    defineTool({
      name: 'set_panel_mode', label: '切换面板模式',
      description: '切换纯对话、附件查看或共同编辑模式，同时打开已有附件或草稿。conversation 不需要 targetId；其余模式必须引用已有 ID。关闭面板不会删除草稿。',
      parameters: Type.Object({
        mode: Type.Union([Type.Literal('conversation'), Type.Literal('attachment'), Type.Literal('editor')]),
        targetId: Type.Optional(id),
      }),
      execute: async (_id, params, signal) => {
        signal?.throwIfAborted();
        return updated(workspace.setMode(params.mode, params.targetId));
      },
    }),
    defineTool({
      name: 'update_panel_content', label: '更新面板正文',
      description: '创建或按段落更新本地草稿，并直接打开编辑模式。新建时 expectedVersion=0 且提供 title；修改已有文档必须使用当前版本。operations 按顺序原子应用。insert 不填 afterId 时追加到末尾；replace 保留段落 ID。格式通过 block.kind 指定，paragraph/heading/quote 使用纯文本，list 每行一项，code 为代码原文。不能修改附件原件。',
      parameters: Type.Object({
        documentId: id,
        expectedVersion: Type.Integer({ minimum: 0 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
        operations: Type.Array(Type.Object({
          action: Type.Union([Type.Literal('insert'), Type.Literal('replace'), Type.Literal('delete')]),
          targetId: Type.Optional(id), afterId: Type.Optional(id), block: Type.Optional(block),
        }), { minItems: 1, maxItems: 100 }),
      }),
      execute: async (_id, params, signal) => {
        signal?.throwIfAborted();
        return updated(workspace.update(params));
      },
    }),
    defineTool({
      name: 'get_panel_state', label: '读取面板状态',
      description: '按需读取最新面板模式、可用附件和草稿。指定 documentId 可读取该草稿全文，再指定 blockId 只读取一段；指定 attachmentId 读取附件完整文本或地址。已有上下文足够时不必重复读取。图片地址只用于展示，不代表你已看懂图片。',
      parameters: Type.Object({ documentId: Type.Optional(id), blockId: Type.Optional(id), attachmentId: Type.Optional(id) }),
      execute: async (_id, params, signal) => {
        signal?.throwIfAborted();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(workspace.read(params.documentId, params.blockId, params.attachmentId)) }],
          details: {},
        };
      },
    }),
  ];
}
