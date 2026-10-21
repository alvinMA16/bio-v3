import type { NarrationChunk } from './document-narration.js';
import type { DocumentView } from '@bio/contracts';

/** Runtime-only capabilities; never accepted as model/user-provided request parameters. */
export interface DocumentRuntime {
  narrate?: (chunks: NarrationChunk[], onPlayed: (index: number) => void, signal?: AbortSignal) => Promise<void>;
  beforeShow?: (signal?: AbortSignal) => Promise<void>;
  getView?: () => DocumentView | undefined;
  observeViews?: (listener: (event: { view: DocumentView; accepted: boolean }) => void) => () => void;
  waitForNavigation?: (target: { documentId: string; version: number; requestId: string }, signal?: AbortSignal) => Promise<DocumentView | undefined>;
}
