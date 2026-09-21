import type { PanelDocument } from './index.js';

export interface DocumentRange { blockId: string; start: number; end: number }
export interface DocumentHighlight {
  requestId: string;
  kind: 'change' | 'focus';
  ranges: DocumentRange[];
  deletions?: Array<{ blockId: string; text: string }>;
  notice?: string;
}

/** Split for viewport reporting without widening a highlight to the surrounding text. */
export function documentTextSegments(text: string, blockId: string, ranges: DocumentRange[] = [], base = 0) {
  const boundaries = new Set([0, text.length]);
  let offset = 0, count = 0;
  for (const char of text) { offset += char.length; if (++count % 80 === 0) boundaries.add(offset); }
  const local = ranges.filter(range => range.blockId === blockId && range.end > base && range.start < base + text.length);
  for (const range of local) {
    boundaries.add(Math.max(0, range.start - base)); boundaries.add(Math.min(text.length, range.end - base));
  }
  const cuts = [...boundaries].sort((a, b) => a - b);
  return cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1]!;
    return { text: text.slice(start, end), start: base + start, end: base + end,
      highlighted: local.some(range => range.start <= base + start && range.end >= base + end) };
  });
}

/** page is an internal narration chunk, not a user-facing page. */
export interface DocumentView {
  documentId: string;
  version: number;
  page: number;
  /** Text ranges intersecting the viewport; offsets use UTF-16. */
  visibleRanges?: Array<{ blockId: string; start: number; end: number }>;
  following?: boolean;
  /** Explicit request to resume following, distinct from normal narration movement. */
  followRequest?: number;
  /** Temporary presentation only; never part of the saved manuscript. */
  highlight?: DocumentHighlight;
  /** One-shot exact navigation, independent of ongoing narration following. */
  focus?: DocumentRange & { requestId: string };
}
export interface DocumentPage {
  page: number;
  fragments: Array<{ blockId: string; kind: string; text: string; start: number; end: number }>;
}
export function documentPages(document: PanelDocument): DocumentPage[] {
  const pages: DocumentPage[] = [{ page: 1, fragments: [] }];
  let used = 0;
  for (const block of document.blocks) {
    // Stable boundaries across platforms. Do not split a Unicode surrogate pair.
    const characters = Array.from(block.text);
    let offset = 0;
    for (let i = 0; i < characters.length || (i === 0 && !characters.length);) {
      if (used >= 600 || (i === 0 && characters.length <= 600 && used + characters.length > 600)) {
        pages.push({ page: pages.length + 1, fragments: [] }); used = 0;
      }
      const count = Math.min(600 - used, characters.length - i);
      const text = characters.slice(i, i + count).join('');
      pages.at(-1)!.fragments.push({ blockId: block.id, kind: block.kind, text, start: offset, end: offset + text.length });
      used += count; i += count; offset += text.length;
      if (!characters.length) break;
    }
  }
  return pages;
}
