import type { SessionSummary } from '@bio/contracts';

export interface ReceiptMessage { role: 'user' | 'assistant'; content: string }
export interface SessionReceipt {
  id: string;
  date: string;
  timeRange: string;
  duration: string;
  shares: number;
  replies: number;
  summary: string;
  topics: string[];
  status: 'pending' | 'ready' | 'excerpt';
}

const STORAGE_KEY = 'lingli.last-session-receipt.v1';
let latest: SessionReceipt | null = null;
let pending: { receipt: SessionReceipt; messages: ReceiptMessage[] } | null = null;
const pad = (value: number) => String(value).padStart(2, '0');
const time = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

export function createReceipt(messages: ReceiptMessage[], startedAt: number, endedAt: number, activeMs: number): SessionReceipt | null {
  const shares = messages.filter(message => message.role === 'user' && message.content.trim());
  if (!shares.length) return null;
  const start = new Date(startedAt), end = new Date(endedAt);
  const seconds = Math.max(1, Math.floor(activeMs / 1000));
  const excerpt = shares[0]!.content.replace(/\s+/g, ' ').trim();
  return {
    id: `${startedAt}-${endedAt}`,
    date: `${start.getFullYear()}.${pad(start.getMonth() + 1)}.${pad(start.getDate())}`,
    timeRange: `${time(start)} — ${start.toDateString() !== end.toDateString() ? `${end.getMonth() + 1}/${end.getDate()} ` : ''}${time(end)}`,
    duration: seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
    shares: shares.length,
    replies: messages.filter(message => message.role === 'assistant' && message.content.trim()).length,
    summary: `“${excerpt.slice(0, 70)}${excerpt.length > 70 ? '…' : ''}”`,
    topics: [],
    status: 'pending',
  };
}

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
