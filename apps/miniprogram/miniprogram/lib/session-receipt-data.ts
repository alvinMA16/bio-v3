export interface ReceiptMessage { role: 'user' | 'assistant'; content: string }
export interface SessionReceipt {
  id: string;
  date: string;
  timeRange: string;
  duration: string;
  shares: number;
  replies: number;
}

const pad = (value: number) => String(value).padStart(2, '0');
const time = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

export function createReceipt(messages: ReceiptMessage[], startedAt: number, endedAt: number, activeMs: number): SessionReceipt | null {
  const shares = messages.filter(message => message.role === 'user' && message.content.trim());
  if (!shares.length) return null;
  const start = new Date(startedAt), end = new Date(endedAt);
  const seconds = Math.max(1, Math.floor(activeMs / 1000));
  return {
    id: `${startedAt}-${endedAt}`,
    date: `${start.getFullYear()}.${pad(start.getMonth() + 1)}.${pad(start.getDate())}`,
    timeRange: `${time(start)} — ${start.toDateString() !== end.toDateString() ? `${end.getMonth() + 1}/${end.getDate()} ` : ''}${time(end)}`,
    duration: seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
    shares: shares.length,
    replies: messages.filter(message => message.role === 'assistant' && message.content.trim()).length,
  };
}


/** Retain basic data from older receipts without carrying forward their generated text. */
export function parseReceipt(value: unknown): SessionReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (!['id', 'date', 'timeRange', 'duration'].every(key => typeof data[key] === 'string')
    || typeof data.shares !== 'number' || !Number.isSafeInteger(data.shares) || data.shares < 0
    || typeof data.replies !== 'number' || !Number.isSafeInteger(data.replies) || data.replies < 0) return null;
  return { id: data.id as string, date: data.date as string, timeRange: data.timeRange as string,
    duration: data.duration as string, shares: data.shares, replies: data.replies };
}
