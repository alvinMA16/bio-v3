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
        mode: workspace.scene(), panelMode: panel.mode, revision: panel.revision,
        document: panel.document && {
          id: panel.document.id, title: panel.document.title, version: panel.document.version,
          blockIds: panel.document.blocks.map(item => item.id),
        },
        attachmentId: panel.attachment?.id,
        note: '内容展示状态已在本地会话保存，已生成更新事件；未确认客户端渲染，未发布文章或修改附件原件。',
      }) }],
      details: { revision: panel.revision },
    };
  };
  return [
    defineTool({
      name: 'switch_mode', label: '切换模式',
      description: '同时切换对话模式、屏幕主内容和后续模型调用的场景指引。conversation 展示 agent 说话的文字，不接受 targetId；attachment_conversation 展示已有附件，targetId 必填；revision 可用 targetId 打开已有文档，不传则进入空白编辑区，随后用 update_content 创建文档。用户发来要聊的附件或指定附件时，选定已有 ID 后切换；用户要求查看或修改文档时先切到 revision；要求收起内容、回到对话时切到 conversation。当前模式和对象已匹配时不重复调用。切换不修改正文、不删除草稿、不结束通话，通话播放与麦克风由客户端管理。目标无效时不切换。',
      parameters: Type.Object({
        mode: Type.Union([Type.Literal('conversation'), Type.Literal('attachment_conversation'), Type.Literal('revision')]),
        targetId: Type.Optional(id),
      }),
      execute: async (_id, params, signal) => {
        signal?.throwIfAborted();
        return updated(workspace.switchMode(params.mode, params.targetId));
      },
    }),
    defineTool({
      name: 'update_content', label: '更新内容',
      description: '仅在 revision 模式创建或按段落更新本地草稿，并展示更新后的文档；不会切换模式，其他模式调用会失败，必须先用 switch_mode 进入 revision。用户明确要求创作或修改时执行，询问怎么改时先给建议。新建时 expectedVersion=0 且提供 title；修改已有文档必须使用当前版本，版本冲突先重新读取，不强行覆盖。operations 按顺序原子应用。insert 不填 afterId 时追加到末尾；replace 保留段落 ID。格式通过 block.kind 指定，paragraph/heading/quote 使用纯文本，list 每行一项，code 为代码原文。不能修改附件原件。',
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
      name: 'get_content', label: '读取内容',
      description: '按需读取当前内容展示模式、可用附件和草稿。指定 documentId 可读取该草稿全文，再指定 blockId 只读取一段；指定 attachmentId 读取附件完整文本或地址。已有上下文足够时不必重复读取。图片地址只用于展示，不代表你已看懂图片。',
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
