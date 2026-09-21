import type { PanelDocument } from './index.js';

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
