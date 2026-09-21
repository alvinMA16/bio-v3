import { diffChars } from 'diff';
import { randomUUID } from 'node:crypto';
import type { DocumentHighlight, PanelDocument } from '@bio/contracts';

export type HighlightGranularity = 'reading' | 'character';
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const words = new Intl.Segmenter('und', { granularity: 'word' });

/** Display units are independent of the exact edit diff and always use UTF-16 offsets. */
function readingUnits(text: string, granularity: HighlightGranularity) {
  const units = Array.from(graphemes.segment(text), item => ({ start: item.index, end: item.index + item.segment.length }));
  if (granularity === 'character') return units;
  for (const word of words.segment(text)) {
    // Chinese can be corrected one complete character at a time; alphabetic words stay whole.
    if (word.isWordLike && !/\p{Script=Han}/u.test(word.segment)) units.push({ start: word.index, end: word.index + word.segment.length });
  }
  // Keep connected identifiers and signed/fractional numbers intact across word-segment boundaries.
  for (const match of text.matchAll(/[\p{Script=Latin}\p{N}\p{M}_]+(?:[-'’][\p{Script=Latin}\p{N}\p{M}_]+)+|(?<![\p{L}\p{N}_])[+−-]?\p{N}+(?:[.,]\p{N}+)*(?:[eE][+−-]?\p{N}+)?[%％]?/gu)) {
    units.push({ start: match.index, end: match.index + match[0].length });
  }
  const merged: Array<{ start: number; end: number }> = [];
  for (const unit of units.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (previous && unit.start < previous.end) previous.end = Math.max(previous.end, unit.end);
    else merged.push({ ...unit });
  }
  return merged;
}

function expandRange(start: number, end: number, units: Array<{ start: number; end: number }>) {
  const containing = (offset: number) => {
    let low = 0, high = units.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (units[middle]!.end <= offset) low = middle + 1;
      else high = middle;
    }
    return units[low];
  };
  return { start: containing(start)?.start ?? start, end: containing(end - 1)?.end ?? end };
}

/** Diff Unicode code points, then expose UTF-16 offsets matching browser text nodes. */
export function changedText(before: PanelDocument | undefined, after: PanelDocument, granularity: HighlightGranularity = 'reading'): DocumentHighlight {
  const highlight: DocumentHighlight = { requestId: randomUUID(), kind: 'change', ranges: [], deletions: [] };
  for (const block of after.blocks) {
    const old = before?.blocks.find(item => item.id === block.id)?.text ?? '';
    if (old === block.text) continue;
    const changes = diffChars(old, block.text, { timeout: 200 });
    if (!changes) { highlight.notice = '部分大幅改写未能精确标记，可让令狸定位具体内容。'; continue; }
    let offset = 0;
    const units = readingUnits(block.text, granularity);
    for (const change of changes) {
      if (change.removed) highlight.deletions!.push({ blockId: block.id, text: change.value });
      else {
        if (change.added) {
          const range = { blockId: block.id, ...expandRange(offset, offset + change.value.length, units) };
          const previous = highlight.ranges.at(-1);
          if (previous?.blockId === block.id && previous.end >= range.start) previous.end = Math.max(previous.end, range.end);
          else highlight.ranges.push(range);
        }
        offset += change.value.length;
      }
    }
  }
  for (const block of before?.blocks ?? []) {
    if (!after.blocks.some(item => item.id === block.id)) highlight.deletions!.push({ blockId: block.id, text: block.text });
  }
  return highlight;
}

export function locateText(document: PanelDocument, target: { blockId: string; quote: string; occurrence?: number; granularity?: HighlightGranularity | undefined }) {
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
  return { blockId: block.id, ...expandRange(start, end, readingUnits(block.text, target.granularity ?? 'reading')) };
}
