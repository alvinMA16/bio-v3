/** Model-authored portion only. Call identity and times always come from the server. */
export interface CallSummary {
  summary: string;
  follow_ups: Array<{ topic: string; not_before: string | null; context: string }>;
}

export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateCallSummary(value: unknown): asserts value is CallSummary {
  const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x: unknown, max: number) => typeof x === 'string' && x.trim().length > 0 && Array.from(x).length <= max;
  if (!record(value) || Object.keys(value).some(key => !['summary', 'follow_ups'].includes(key))
    || !text(value.summary, 250) || !Array.isArray(value.follow_ups) || value.follow_ups.length > 2
    || !value.follow_ups.every(item => record(item)
      && Object.keys(item).every(key => ['topic', 'not_before', 'context'].includes(key))
      && text(item.topic, 100) && text(item.context, 150)
      && (item.not_before === null || typeof item.not_before === 'string' && isCalendarDate(item.not_before)))) {
    throw new Error('Invalid call summary');
  }
}

/** Product dates use Beijing time; no per-call timezone field is needed. */
export function beijingTime(value: Date | string): string {
  return new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

export const CALL_HISTORY_RULES = `call_history 是按次保存的历史背景，interaction 是跨通话持续互动的当前进展，两者不同。
本次开始时间不是持续刷新的时钟。所有日期按北京时间理解。历史摘要中的计划不代表已发生；较新的结果、取消和纠正优先于旧计划。
优先回应用户本次意图；follow_ups 只是可选线索，不逐项追问，不因日期已到就假设事情发生，久远线索不默认仍有效。
“今天先聊到这里”等结束语只适用于当次交谈；用户再次主动发言时自然回应，不沿用上次结束状态。
查看原话时使用对应 callId 调用 read_source；更早的通话用 search_call_history 按日期或关键词查找，再读取原文。
pendingCalls 尚未整理，必要时用其 callId 读取原文。callId 和其他内部引用只用于工具，不出现在普通回复、语音或作品中。`;
