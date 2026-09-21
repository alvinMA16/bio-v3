import type { AgentScene, PanelAttachment, PanelBlock, PanelDocument, PanelState } from '@bio/contracts';
import { documentPages, type DocumentView, type DocumentHighlight, type DocumentRange } from '@bio/contracts';
import { changedText } from './document-highlight.js';
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
  private readonly originalStatuses = new Map<string, PanelAttachment['originalStatus']>();
  private acknowledgedView?: DocumentView;
  private documentDirectory: Array<Pick<PanelDocument, 'id' | 'title' | 'version'>> = [];

  constructor(cwd: string, attachments: PanelAttachment[] = []) {
    this.path = join(cwd, 'panel.json');
    this.value = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8')) as WorkspaceFile
      : { panel: { mode: 'conversation', revision: 0 }, attachments: [], documents: [] };
    this.documentDirectory = this.value.documents.map(({ id, title, version }) => ({ id, title, version }));
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

  setOriginalStatus(id: string, status: PanelAttachment['originalStatus']): boolean {
    if (this.originalStatuses.get(id) === status) return false;
    this.originalStatuses.set(id, status);
    return true;
  }

  addAttachment(attachment: PanelAttachment): void {
    if (this.value.attachments.some(item => item.id === attachment.id)) return;
    if (this.value.attachments.length >= 100) throw new Error('本会话附件数量已达上限');
    const next = structuredClone(this.value);
    next.attachments.push(structuredClone(attachment));
    this.commit(next);
  }

  private attachmentView(attachment: PanelAttachment): PanelAttachment {
    const originalStatus = this.originalStatuses.get(attachment.id);
    const view = structuredClone(attachment);
    if (originalStatus) { view.originalStatus = originalStatus; delete view.text; }
    return view;
  }

  state(): PanelState {
    const panel = structuredClone(this.value.panel);
    if (panel.document) panel.readingPages = documentPages(panel.document);
    if (panel.attachment) panel.attachment = this.attachmentView(panel.attachment);
    return panel;
  }

  /** Document copies here are presentation caches, not the authoritative store. */
  hydrateDocuments(documents: PanelDocument[], currentId?: string): void {
    const next = structuredClone(this.value);
    this.documentDirectory = documents.map(({ id, title, version }) => ({ id, title, version }));
    // Keep only the open document in the session cache, never copy the user's library into every conversation.
    next.documents = [];
    if (next.panel.document) {
      const restored = documents.find(item => item.id === (currentId ?? next.panel.document!.id));
      if (restored) {
        if (restored.version !== next.panel.document.version) delete next.panel.lastChange;
        next.panel.document = restored;
        next.documents = [restored];
      }
      else { delete next.panel.document; delete next.panel.documentView; }
      if (next.panel.document) next.panel.documentView = {
        ...(next.panel.documentView?.version === next.panel.document.version ? next.panel.documentView : {}),
        documentId: next.panel.document.id, version: next.panel.document.version,
        page: Math.min(next.panel.documentView?.page ?? 1, documentPages(next.panel.document).length),
      };
    }
    this.commit(next);
  }

  acceptDocumentView(view?: DocumentView, openingDocument?: PanelDocument): boolean {
    const document = openingDocument?.id === view?.documentId ? openingDocument : this.value.documents.find(item => item.id === view?.documentId);
    if (!view || !document || document.version !== view.version || !Number.isInteger(view.page)
      || view.page < 1 || view.page > documentPages(document).length) return false;
    if (view.visibleRanges !== undefined) {
      if (view.visibleRanges.length > 100 || view.visibleRanges.some(range => {
          const block = document.blocks.find(block => block.id === range.blockId);
          return !block || !Number.isInteger(range.start) || !Number.isInteger(range.end)
            || range.start < 0 || range.end < range.start || range.end > block.text.length
            || /[\uDC00-\uDFFF]/.test(block.text.charAt(range.start))
            || /[\uDC00-\uDFFF]/.test(block.text.charAt(range.end));
        })) return false;
      if (this.value.panel.mode !== 'editor' || this.value.panel.document?.id !== view.documentId) {
        if (!openingDocument) return false;
        this.showDocument(document, view.page);
      }
      // Viewport reports never change the narrator's cursor or generate display events.
      this.acknowledgedView = structuredClone(view); return true;
    }
    if (this.value.panel.documentView?.documentId !== view.documentId || this.value.panel.documentView.version !== view.version
      || this.value.panel.documentView.page !== view.page || this.value.panel.mode !== 'editor') this.showDocument(document, view.page);
    this.acknowledgedView = { ...view }; return true;
  }

  showDocument(document: PanelDocument, page = 1, follow = false, presentation?: { highlight?: DocumentHighlight; focus?: DocumentRange; clearHighlight?: boolean }): PanelState {
    const pages = documentPages(document);
    if (!Number.isInteger(page) || page < 1 || page > pages.length) throw new Error(`页码超出范围，共 ${pages.length} 页`);
    const next = structuredClone(this.value);
    const previousHighlight = next.panel.documentView?.documentId === document.id && next.panel.documentView.version === document.version
      ? next.panel.documentView.highlight : undefined;
    const highlight = presentation?.clearHighlight ? undefined : presentation?.highlight ?? previousHighlight;
    next.documents = [...next.documents.filter(item => item.id !== document.id), document];
    next.panel = { mode: 'editor', revision: next.panel.revision + 1, document,
      documentView: { documentId: document.id, version: document.version, page, ...(follow ? { followRequest: next.panel.revision + 1 } : {}),
        ...(highlight ? { highlight } : {}),
        ...(presentation?.focus ? { focus: { ...presentation.focus, requestId: randomUUID() } } : {}) } };
    this.commit(next); return this.state();
  }

  documentSaved(document: PanelDocument): PanelState {
    const previous = this.value.documents.find(item => item.id === document.id);
    const next = structuredClone(this.value);
    next.documents = [...next.documents.filter(item => item.id !== document.id), document];
    // Editing never opens or switches the user's document. Only refresh it when already open.
    if (next.panel.document?.id === document.id) {
      const oldPages = documentPages(next.panel.document);
      const anchor = oldPages[(next.panel.documentView?.page ?? 1) - 1]?.fragments[0];
      const pages = documentPages(document);
      const anchoredPage = anchor ? pages.findIndex(item => item.fragments.some(fragment => fragment.blockId === anchor.blockId && fragment.start <= anchor.start && fragment.end >= anchor.start)) : -1;
      next.panel.document = document;
      next.panel.documentView = { documentId: document.id, version: document.version,
        page: anchoredPage >= 0 ? anchoredPage + 1 : Math.min(next.panel.documentView?.page ?? 1, pages.length),
        highlight: changedText(previous, document) };
      next.panel.lastChange = { documentId: document.id, fromVersion: previous?.version ?? 0, toVersion: document.version,
        before: (previous?.blocks ?? []).filter(block => JSON.stringify(block) !== JSON.stringify(document.blocks.find(item => item.id === block.id))),
        after: document.blocks.filter(block => JSON.stringify(block) !== JSON.stringify(previous?.blocks.find(item => item.id === block.id))) };
    }
    next.panel.revision++;
    this.commit(next); return this.state();
  }

  scene(): AgentScene {
    return this.value.panel.mode === 'attachment' ? 'attachment_conversation'
      : this.value.panel.mode === 'editor' ? 'revision' : 'conversation';
  }

  switchMode(mode: AgentScene, targetId?: string): PanelState {
    return this.setMode(mode === 'attachment_conversation' ? 'attachment'
      : mode === 'revision' ? 'editor' : 'conversation', targetId);
  }

  /** Bounded model context. Full content is available through read_document. */
  context() {
    const panel = this.state();
    let remaining = 6000;
    const document = panel.document && {
      id: panel.document.id, title: panel.document.title, version: panel.document.version,
      blocks: panel.document.blocks.map(block => {
        const text = block.text.slice(0, remaining);
        remaining -= text.length;
        return { ...block, text, truncated: text.length < block.text.length };
      }),
    };
    const visibleView = this.acknowledgedView?.documentId === panel.document?.id
      && this.acknowledgedView?.version === panel.document?.version ? this.acknowledgedView : undefined;
    let visibleBudget = 6000;
    const visibleContent = visibleView?.visibleRanges?.map(range => {
      const block = panel.document!.blocks.find(block => block.id === range.blockId)!;
      const text = block.text.slice(range.start, range.end).slice(0, visibleBudget);
      visibleBudget -= text.length;
      return { ...range, kind: block.kind, text, truncated: text.length < range.end - range.start };
    });
    return {
      scene: this.scene(),
      revision: panel.revision, mode: panel.mode, document,
      screen: {
        source: 'server_display_state', renderAcknowledged: panel.mode === 'editor' && !!panel.documentView
          && panel.documentView.documentId === this.acknowledgedView?.documentId
          && panel.documentView.version === this.acknowledgedView.version
          && (visibleContent !== undefined || panel.documentView.page === this.acknowledgedView.page),
        visibleContent: visibleContent ?? null,
        following: visibleView?.following ?? null,
        mainContent: panel.mode === 'conversation' ? 'assistant_speech_text'
          : panel.mode === 'attachment' ? 'attachment' : 'document',
        description: panel.mode === 'conversation'
          ? '主区域展示 agent 说话的文字，随回复更新；不展示附件或文档。服务端未获取客户端当前字幕的精确文本。'
          : panel.mode === 'attachment'
            ? '主区域展示当前附件；普通回复用于播报，不替换附件。'
            : panel.document
              ? '主区域展示当前文档；普通回复用于播报，不替换文档正文，正文修改必须调用内容工具。'
              : '主区域为空白文稿区。先 edit_document 创建，再 show_document 展示。',
        targetId: panel.attachment?.id ?? panel.document?.id ?? null,
        title: panel.attachment?.title ?? panel.document?.title ?? null,
        documentVersion: panel.document?.version ?? null,
        highlight: panel.documentView?.highlight ?? null,
        readingPage: panel.document ? documentPages(panel.document)[(panel.documentView?.page ?? 1) - 1] : null,
        totalPages: panel.document ? documentPages(panel.document).length : null,
      },
      attachment: panel.attachment && { ...panel.attachment, text: panel.attachment.text?.slice(0, 6000), textTruncated: (panel.attachment.text?.length ?? 0) > 6000 },
      availableAttachments: this.value.attachments.map(({ id, kind, title }) => ({ id, kind, title, originalStatus: this.originalStatuses.get(id) })),
      availableDocuments: [...this.documentDirectory.filter(item => !this.value.documents.some(document => document.id === item.id)),
        ...this.value.documents.map(({ id, title, version }) => ({ id, title, version }))],
    };
  }

  read(documentId?: string, blockId?: string, attachmentId?: string) {
    if (attachmentId) {
      if (documentId || blockId) throw new Error('附件与草稿不能同时读取');
      const attachment = this.value.attachments.find(item => item.id === attachmentId);
      if (!attachment) throw new Error('附件不存在');
      const originalStatus = this.originalStatuses.get(attachment.id);
      if (originalStatus) return { id: attachment.id, kind: attachment.kind, title: attachment.title, originalStatus,
        message: originalStatus === 'deleted' ? '原文件已删除。可基于已有对话继续讨论；不能重新读取或核对原件，需要原文时请用户重新上传。' : '原文件不可用。可基于已有对话继续讨论；不能重新读取或核对原件。' };
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
    } else if (mode === 'editor' && targetId) {
      const document = next.documents.find(item => item.id === targetId);
      if (!document) throw new Error('草稿不存在；先通过 update_content 创建草稿');
      panel.document = document;
      panel.documentView = { documentId: document.id, version: document.version, page: 1 };
    } else if (targetId) throw new Error('纯对话模式不接受目标 ID');
    next.panel = panel;
    this.commit(next);
    return this.state();
  }

  update(input: PanelUpdate): PanelState {
    if (this.value.panel.mode !== 'editor') throw new Error('请先调用 switch_mode 进入 revision 模式，再更新文档');
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
