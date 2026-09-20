import type { PanelDocument } from '@bio/contracts';
import type { PanelUpdate } from './panel-workspace.js';

/** Validate a whole batch on a copy before any persistence or display change. */
export function editDocument(previous: PanelDocument | undefined, input: PanelUpdate): PanelDocument {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.documentId)) throw new Error('无效文稿 ID');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('无效版本');
  if (!previous && (input.expectedVersion !== 0 || !input.title?.trim())) throw new Error('创建文稿需要标题和 expectedVersion=0');
  const document: PanelDocument = structuredClone(previous ?? { id: input.documentId, title: input.title!, version: 0, blocks: [] });
  if (document.version !== input.expectedVersion) throw new Error(`版本冲突，当前版本为 ${document.version}，请重新读取后修改`);
  if (!input.operations.length || input.operations.length > 100) throw new Error('每次修改需要 1～100 个操作');
  for (const operation of input.operations) {
    const block = operation.block;
    if (block && (!/^[a-zA-Z0-9_-]{1,64}$/.test(block.id) || !['paragraph', 'heading', 'list', 'quote', 'code'].includes(block.kind)
      || typeof block.text !== 'string' || block.text.length > 12000)) throw new Error('无效段落');
    if (operation.action === 'insert') {
      if (!block || operation.targetId) throw new Error('插入需要 block，不接受 targetId');
      if (document.blocks.some(item => item.id === block.id)) throw new Error('段落 ID 重复');
      const index = operation.afterId ? document.blocks.findIndex(item => item.id === operation.afterId) : document.blocks.length - 1;
      if (operation.afterId && index < 0) throw new Error('插入位置不存在');
      document.blocks.splice(index + 1, 0, structuredClone(block));
    } else {
      if (!operation.targetId || operation.afterId) throw new Error('替换或删除需要 targetId，不接受 afterId');
      const index = document.blocks.findIndex(item => item.id === operation.targetId);
      if (index < 0) throw new Error('目标段落不存在');
      if (operation.action === 'delete') {
        if (block) throw new Error('删除不接受 block');
        document.blocks.splice(index, 1);
      } else if (operation.action === 'replace') {
        if (!block || block.id !== operation.targetId) throw new Error('替换必须保留目标段落 ID');
        document.blocks[index] = structuredClone(block);
      } else throw new Error('无效修改操作');
    }
  }
  if (document.blocks.length > 200 || document.blocks.reduce((sum, block) => sum + block.text.length, 0) > 40000) throw new Error('文稿最多 200 个段落、40000 字符');
  if (input.title !== undefined) {
    if (!input.title.trim() || input.title.length > 300) throw new Error('标题需为 1～300 字符');
    document.title = input.title;
  }
  document.schemaVersion = 1;
  document.version++;
  return document;
}
