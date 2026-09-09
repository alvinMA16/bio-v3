import type { SessionSummary } from '@bio/contracts';

import { createReceipt, type ReceiptMessage, type SessionReceipt } from './session-receipt-data';
export { createReceipt, type ReceiptMessage, type SessionReceipt } from './session-receipt-data';

const STORAGE_KEY = 'lingli.last-session-receipt.v1';
let latest: SessionReceipt | null = null;
let pending: { receipt: SessionReceipt; messages: ReceiptMessage[] } | null = null;
export function saveReceipt(receipt: SessionReceipt): void {
  latest = receipt;
  // Only the latest small receipt is retained, never the transcript.
  try { wx.setStorageSync(STORAGE_KEY, { ...receipt, status: receipt.status === 'pending' ? 'excerpt' : receipt.status }); } catch { /* Still available in memory if storage is full. */ }
}

export function getLatestReceipt(): SessionReceipt | null {
  if (latest) return latest;
  try {
    const value = wx.getStorageSync(STORAGE_KEY) as SessionReceipt | undefined;
    if (value && typeof value.id === 'string' && typeof value.summary === 'string'
      && typeof value.date === 'string' && typeof value.timeRange === 'string'
      && typeof value.duration === 'string' && typeof value.shares === 'number'
      && typeof value.replies === 'number' && Array.isArray(value.topics)
      && value.topics.every(topic => typeof topic === 'string')
      && ['ready', 'excerpt'].includes(value.status)) latest = value;
  } catch { /* An unavailable local cache does not block the home screen. */ }
  return latest;
}

export function queueReceipt(receipt: SessionReceipt, messages: ReceiptMessage[]): void {
  saveReceipt(receipt);
  // Bound the summarization input while keeping both the opening and the recent exchange.
  const selected = messages.length > 40 ? [...messages.slice(0, 10), ...messages.slice(-30)] : messages;
  pending = { receipt, messages: selected.map(({ role, content }) => ({ role, content: content.slice(0, 1000) })) };
}

export function takePendingReceipt() {
  const value = pending;
  pending = null;
  return value;
}

export function summarizeReceipt(receipt: SessionReceipt, messages: ReceiptMessage[], updated: (value: SessionReceipt) => void): void {
  const finish = (result?: SessionSummary) => {
    // A late response from an older session must not replace a newer receipt.
    if (getLatestReceipt()?.id !== receipt.id) return;
    const next: SessionReceipt = { ...receipt, ...(result ?? {}), status: result ? 'ready' : 'excerpt' };
    saveReceipt(next);
    updated(next);
  };
  wx.request<SessionSummary>({
    url: `${getApp<IAppOption>().globalData.apiBaseUrl}/chat/session-summary`,
    method: 'POST',
    data: { messages },
    timeout: 20_000,
    success: ({ data, statusCode }) => {
      if (statusCode >= 200 && statusCode < 300 && typeof data?.summary === 'string' && Array.isArray(data.topics)
        && data.topics.every(topic => typeof topic === 'string')) finish(data);
      else finish();
    },
    fail: () => finish(),
  });
}
