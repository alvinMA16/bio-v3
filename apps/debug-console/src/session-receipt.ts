import type { VoiceServerMessage } from '@bio/contracts';
import { parseReceipt, type ReceiptMessage, type SessionReceipt } from '../../miniprogram/miniprogram/lib/session-receipt-data.ts';
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
  try { localStorage.setItem(KEY, JSON.stringify(parseReceipt(receipt))); } catch { /* Keep the in-memory receipt available. */ }
}

export function readReceipt(): SessionReceipt | null {
  try { return parseReceipt(JSON.parse(localStorage.getItem(KEY) ?? 'null')); }
  catch { return null; }
}
