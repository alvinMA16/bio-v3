import type { DocumentRange, DocumentNarrationPosition, PanelDocument } from '@bio/contracts';

export interface NarrationChunk extends DocumentNarrationPosition { text: string }
export interface NarrationCheckpoint {
  documentId: string; version: number; chunks: DocumentRange[]; next: number;
}

/** Deterministic original-text slices. Offsets always refer to the pinned manuscript. */
export function narrationChunks(document: PanelDocument, ranges?: DocumentRange[]): NarrationChunk[] {
  const selected = ranges ?? document.blocks.map(b => ({ blockId: b.id, start: 0, end: b.text.length }));
  const result: NarrationChunk[] = [];
  for (const range of selected) {
    const block = document.blocks.find(b => b.id === range.blockId);
    if (!block || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0
      || range.end > block.text.length || range.end < range.start
      || /[\uDC00-\uDFFF]/.test(block.text.charAt(range.start)) || /[\uDC00-\uDFFF]/.test(block.text.charAt(range.end))) throw new Error('朗读范围已失效');
    let start = range.start;
    while (start < range.end) {
      const chars = Array.from(block.text.slice(start, range.end));
      let size = chars.slice(0, 180).join('').length;
      const head = block.text.slice(start, start + size);
      const boundaries = [...head.matchAll(/[。！？!?；;\n]/gu)];
      const last = boundaries.at(-1);
      if (last && last.index! + 1 >= 40) size = last.index! + 1;
      const end = start + size;
      result.push({ documentId: document.id, version: document.version, blockId: block.id, start, end, text: block.text.slice(start, end) });
      start = end;
    }
  }
  return result;
}
