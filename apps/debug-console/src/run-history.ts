import type { ChatCompletionRequest, ChatCompletionResponse, PanelState } from '@bio/contracts';
import type { LiveRun } from './live-run';

export interface RunRecord {
  id: string;
  conversationId?: string;
  startedAt: string;
  durationMs: number;
  request: ChatCompletionRequest;
  response?: ChatCompletionResponse;
  error?: string;
  panel?: PanelState;
  live?: LiveRun;
}

export function conversationOf(run: RunRecord): string | undefined {
  return run.conversationId ?? run.response?.conversationId ?? run.request.conversationId;
}

/** Only show turns up to the selected snapshot; never mix unrelated conversations. */
export function conversationThrough(history: RunRecord[], selected: RunRecord | undefined): RunRecord[] {
  if (!selected) return [];
  const index = history.findIndex(run => run.id === selected.id);
  if (index < 0) return [];
  const id = conversationOf(selected);
  if (!id) return [selected];
  return history.slice(index).filter(run => conversationOf(run) === id).reverse();
}

export function panelOf(run?: RunRecord): PanelState | undefined {
  if (run?.panel) return run.panel;
  const events = run?.response?.events ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'panel.state.updated') return event.panel;
    if (event.type === 'panel.updated') return {
      mode: 'editor', revision: 0,
      document: { id: event.panel.id, title: event.panel.title, version: 0, blocks: [{ id: 'legacy', kind: 'paragraph', text: event.panel.content }] },
    };
  }
  return undefined;
}
