import type { PanelAttachment, PanelBlock, PanelDocument, PanelState } from '@bio/contracts';
import { existsSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface WorkspaceFile {
  panel: PanelState;
  attachments: PanelAttachment[];
  documents: PanelDocument[];
}

export interface PanelUpdate {
  documentId: string;
  expectedVersion: number;
  title?: string;
  operations: Array<{
    action: 'insert' | 'replace' | 'delete';
    targetId?: string;
    afterId?: string;
    block?: PanelBlock;
  }>;
}

/** Local, per-conversation drafts; writes are serialized by AgentService's run lock. */
export class PanelWorkspace {
  private value: WorkspaceFile;
  private readonly path: string;

  constructor(cwd: string, attachments: PanelAttachment[] = []) {
    this.path = join(cwd, 'panel.json');
    this.value = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8')) as WorkspaceFile
      : { panel: { mode: 'conversation', revision: 0 }, attachments: [], documents: [] };
    const next = structuredClone(this.value);
    for (const attachment of attachments) {
      if ((attachment.kind === 'image' && !attachment.url) || (attachment.kind === 'document' && !attachment.text && !attachment.url)) {
        throw new Error('附件必须提供可展示的内容或地址');
      }
      const existing = next.attachments.find(item => item.id === attachment.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(attachment)) throw new Error('附件 ID 已存在，请为不同内容使用新 ID');
      if (!existing) next.attachments.push(structuredClone(attachment));
    }
    if (next.attachments.length > 100) throw new Error('本会话附件数量已达上限');
    if (attachments.length) this.commit(next);
  }

  state(): PanelState { return structuredClone(this.value.panel); }

  /** Bounded model context. Full content is available through get_content. */
  context() {
    const panel = this.value.panel;
    let remaining = 6000;
    const document = panel.document && {
      id: panel.document.id, title: panel.document.title, version: panel.document.version,
      blocks: panel.document.blocks.map(block => {
        const text = block.text.slice(0, remaining);
        remaining -= text.length;
        return { ...block, text, truncated: text.length < block.text.length };
      }),
    };
    return {
      revision: panel.revision, mode: panel.mode, document,
      attachment: panel.attachment && { ...panel.attachment, text: panel.attachment.text?.slice(0, 6000), textTruncated: (panel.attachment.text?.length ?? 0) > 6000 },
      availableAttachments: this.value.attachments.map(({ id, kind, title }) => ({ id, kind, title })),
      availableDocuments: this.value.documents.map(({ id, title, version }) => ({ id, title, version })),
    };
  }

  read(documentId?: string, blockId?: string, attachmentId?: string) {
    if (attachmentId) {
      if (documentId || blockId) throw new Error('附件与草稿不能同时读取');
      const attachment = this.value.attachments.find(item => item.id === attachmentId);
      if (!attachment) throw new Error('附件不存在');
      return structuredClone(attachment);
    }
    if (!documentId) {
      if (blockId) throw new Error('读取段落需要 documentId');
      return this.context();
    }
    const document = this.value.documents.find(item => item.id === documentId);
    if (!document) throw new Error('文档不存在');
    const blocks = blockId ? document.blocks.filter(block => block.id === blockId) : document.blocks;
    if (blockId && !blocks.length) throw new Error('段落不存在');
    return structuredClone({ ...document, blocks });
  }

  setMode(mode: PanelState['mode'], targetId?: string): PanelState {
    const next = structuredClone(this.value);
    const panel: PanelState = { mode, revision: next.panel.revision + 1 };
    if (mode === 'attachment') {
      const attachment = next.attachments.find(item => item.id === targetId);
      if (!attachment) throw new Error('附件不存在，只能打开已提供的附件 ID');
      panel.attachment = attachment;
    } else if (mode === 'editor') {
      const document = next.documents.find(item => item.id === targetId);
      if (!document) throw new Error('草稿不存在；先通过 update_content 创建草稿');
      panel.document = document;
    } else if (targetId) throw new Error('纯对话模式不接受目标 ID');
    next.panel = panel;
    this.commit(next);
    return this.state();
  }

  update(input: PanelUpdate): PanelState {
    const next = structuredClone(this.value);
    let document = next.documents.find(item => item.id === input.documentId);
    if (!document) {
      if (input.expectedVersion !== 0 || !input.title?.trim()) throw new Error('创建草稿需要标题和 expectedVersion=0');
      if (next.documents.length >= 50) throw new Error('本会话草稿数量已达上限');
      document = { id: input.documentId, title: input.title, version: 0, blocks: [] };
      next.documents.push(document);
    }
    if (document.version !== input.expectedVersion) throw new Error(`版本冲突，当前版本为 ${document.version}，请重新读取后修改`);
    const before = structuredClone(document.blocks);
    for (const operation of input.operations) {
      if (operation.action === 'insert') {
        if (!operation.block || operation.targetId) throw new Error('插入需要 block，不接受 targetId');
        if (document.blocks.some(block => block.id === operation.block!.id)) throw new Error('段落 ID 重复');
        const index = operation.afterId ? document.blocks.findIndex(block => block.id === operation.afterId) : document.blocks.length - 1;
        if (operation.afterId && index < 0) throw new Error('插入位置不存在');
        document.blocks.splice(index + 1, 0, structuredClone(operation.block));
      } else {
        if (!operation.targetId || operation.afterId) throw new Error('替换或删除需要 targetId，不接受 afterId');
        const index = document.blocks.findIndex(block => block.id === operation.targetId);
        if (index < 0) throw new Error('目标段落不存在');
        if (operation.action === 'delete') {
          if (operation.block) throw new Error('删除不接受 block');
          document.blocks.splice(index, 1);
        } else {
          if (!operation.block || operation.block.id !== operation.targetId) throw new Error('替换必须保留目标段落 ID');
          document.blocks[index] = structuredClone(operation.block);
        }
      }
    }
    if (document.blocks.length > 200 || document.blocks.reduce((sum, block) => sum + block.text.length, 0) > 40000) throw new Error('草稿最多 200 个段落、40000 字符');
    if (input.title !== undefined) {
      if (!input.title.trim()) throw new Error('标题不能为空');
      document.title = input.title;
    }
    document.version++;
    next.panel = {
      mode: 'editor', revision: next.panel.revision + 1, document,
      lastChange: {
        documentId: document.id, fromVersion: input.expectedVersion, toVersion: document.version,
        before: before.filter(block => JSON.stringify(block) !== JSON.stringify(document!.blocks.find(item => item.id === block.id))),
        after: document.blocks.filter(block => JSON.stringify(block) !== JSON.stringify(before.find(item => item.id === block.id))),
      },
    };
    this.commit(next);
    return this.state();
  }

  private commit(next: WorkspaceFile): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      renameSync(temporary, this.path);
      this.value = next;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
