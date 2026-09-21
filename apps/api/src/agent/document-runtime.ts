import type { DocumentView } from '@bio/contracts';

/** Runtime-only capabilities; never accepted as model/user-provided request parameters. */
export interface DocumentRuntime {
  beforeShow?: (signal?: AbortSignal) => Promise<void>;
  getView?: () => DocumentView | undefined;
  observeViews?: (listener: (event: { view: DocumentView; accepted: boolean }) => void) => () => void;
  waitForNavigation?: (target: { documentId: string; version: number; requestId: string }, signal?: AbortSignal) => Promise<DocumentView | undefined>;
}
