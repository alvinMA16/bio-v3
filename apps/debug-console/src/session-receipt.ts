import type { VoiceServerMessage } from '@bio/contracts';
import type { ReceiptMessage, SessionReceipt } from '../../miniprogram/miniprogram/lib/session-receipt-data.ts';
export { createReceipt } from '../../miniprogram/miniprogram/lib/session-receipt-data.ts';
export type { SessionReceipt } from '../../miniprogram/miniprogram/lib/session-receipt-data.ts';

const KEY = 'lingli.last-session-receipt.v1';
export type CallMessages = Map<string, ReceiptMessage>;

export function collectReceiptMessage(messages: CallMessages, event: VoiceServerMessage): void {
  if (event.type === 'transcript' || event.type === 'asr') {
    if (event.text.trim()) messages.set(`user:${event.turnId}`, { role: 'user', content: event.text });
  }
  if (event.type === 'agent') {
    const item = event.event;
    if (item.type === 'speech.delta' || item.type === 'speech.completed') {
      const key = `assistant:${item.messageId}`;
      messages.set(key, { role: 'assistant', content: item.type === 'speech.completed' ? item.text : (messages.get(key)?.content ?? '') + item.delta });
    }
  }
}

export function saveReceipt(receipt: SessionReceipt): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...receipt, status: receipt.status === 'pending' ? 'excerpt' : receipt.status })); } catch { /* Keep the in-memory receipt available. */ }
}

export function readReceipt(): SessionReceipt | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (value && ['id', 'date', 'timeRange', 'duration', 'summary'].every(key => typeof value[key] === 'string')
      && Number.isFinite(value.shares) && Number.isFinite(value.replies)
      && Array.isArray(value.topics) && value.topics.every((topic: unknown) => typeof topic === 'string')
      && ['ready', 'excerpt'].includes(value.status)) return value;
  } catch { /* Corrupt or unavailable storage must not block calls. */ }
  return null;
}

export async function summarizeReceipt(receipt: SessionReceipt, messages: ReceiptMessage[]): Promise<SessionReceipt> {
  try {
    const selected = messages.length > 40 ? [...messages.slice(0, 10), ...messages.slice(-30)] : messages;
    const response = await fetch('/api/v1/chat/session-summary', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: selected.map(({ role, content }) => ({ role, content: content.slice(0, 1000) })) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Summary unavailable');
    const value = await response.json();
    if (typeof value?.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.topics)
      || !value.topics.every((topic: unknown) => typeof topic === 'string')) throw new Error('Invalid summary');
    return { ...receipt, summary: value.summary, topics: value.topics, status: 'ready' };
  } catch { return { ...receipt, status: 'excerpt' }; }
}
