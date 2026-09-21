import { diffChars } from 'diff';
import { randomUUID } from 'node:crypto';
import type { DocumentHighlight, PanelDocument } from '@bio/contracts';

/** Diff Unicode code points, then expose UTF-16 offsets matching browser text nodes. */
export function changedText(before: PanelDocument | undefined, after: PanelDocument): DocumentHighlight {
  const highlight: DocumentHighlight = { requestId: randomUUID(), kind: 'change', ranges: [], deletions: [] };
  for (const block of after.blocks) {
    const old = before?.blocks.find(item => item.id === block.id)?.text ?? '';
    if (old === block.text) continue;
    const changes = diffChars(old, block.text, { timeout: 200 });
    if (!changes) { highlight.notice = '部分大幅改写未能精确标记，可让令狸定位具体内容。'; continue; }
    let offset = 0;
    for (const change of changes) {
      if (change.removed) highlight.deletions!.push({ blockId: block.id, text: change.value });
      else {
        if (change.added) highlight.ranges.push({ blockId: block.id, start: offset, end: offset + change.value.length });
        offset += change.value.length;
      }
    }
  }
  for (const block of before?.blocks ?? []) {
    if (!after.blocks.some(item => item.id === block.id)) highlight.deletions!.push({ blockId: block.id, text: block.text });
  }
  return highlight;
}

export function locateText(document: PanelDocument, target: { blockId: string; quote: string; occurrence?: number }) {
  const block = document.blocks.find(item => item.id === target.blockId);
  if (!block) throw new Error('段落不存在');
  if (!target.quote) throw new Error('高亮必须指定非空的原文 quote');
  const matches: number[] = [];
  for (let at = block.text.indexOf(target.quote); at >= 0; at = block.text.indexOf(target.quote, at + 1)) matches.push(at);
  if (!matches.length) throw new Error('quote 与当前段落原文不匹配，请重新读取，不要猜测位置');
  if (matches.length > 1 && target.occurrence === undefined) throw new Error(`原文在该段落出现 ${matches.length} 次，请指定 occurrence（从 1 开始）`);
  const start = matches[(target.occurrence ?? 1) - 1];
  if (start === undefined) throw new Error('occurrence 超出匹配范围');
  const end = start + target.quote.length;
  if (/[\uDC00-\uDFFF]/.test(block.text.charAt(start)) || /[\uDC00-\uDFFF]/.test(block.text.charAt(end))) throw new Error('不能拆分 Unicode 字符');
  return { blockId: block.id, start, end };
}
