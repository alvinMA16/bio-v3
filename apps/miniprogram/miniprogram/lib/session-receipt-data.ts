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

