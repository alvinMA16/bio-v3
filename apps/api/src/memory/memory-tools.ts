import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { MemoryService } from './memory.service.js';

const uuid = Type.String({ format: 'uuid', maxLength: 36 });
const offset = Type.Optional(Type.Integer({ minimum: 0, maximum: 100000000 }));
export function createMemoryTools(memory: MemoryService, user: string, onSource?: (value: any) => void) {
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
  return [
    defineTool({ name: 'search_call_history', label: '查找通话历史',
      description: '查找当前用户已结束的通话，返回时间、简短摘要和用于 read_source 的 callId。date 按北京时间 YYYY-MM-DD 匹配通话开始日期，query 可选关键词；均省略时按最近排序。摘要为 null 表示尚无摘要，仍可读取原文。nextOffset 非空时继续翻页。内部 ID 不对用户展示。',
      parameters: Type.Object({ query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), date: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })), offset }),
      execute: async (_id, p, signal) => { signal?.throwIfAborted(); return result(await memory.searchCallHistory(user, p.query, p.date, p.offset)); },
    }),
    defineTool({ name: 'search_memory', label: '查找记忆',
      description: '按人物、事件、主题查找当前用户的详细记忆，返回简短摘要和内部读取 ID；空结果不代表从未讲过。概要足够时不用调用。中文可尝试更短的人名或关键词。',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), type: Type.Optional(Type.Union(['person', 'story', 'interaction'].map(value => Type.Literal(value)))), offset }),
      execute: async (_id, p, signal) => { signal?.throwIfAborted(); return result(await memory.search(user, p.query, p.type, p.offset)); },
    }),
    defineTool({ name: 'read_memory', label: '回忆详情', description: '读取人物、故事或互动与近况的当前有效版本与来源。nextOffset 非空时可继续读。ID 与来源字段只用于内部操作。',
      parameters: Type.Object({ memoryId: uuid, offset }),
      execute: async (_id, p, signal) => { signal?.throwIfAborted(); return result(await memory.read(user, p.memoryId, p.offset)); },
    }),
    defineTool({ name: 'read_source', label: '回看讲述', description: '提供 sourceRef 读取一条原始讲述及相邻上下文；或提供 callId 和 after 顺序读取一通电话，nextAfter 可继续翻页。只能二选一。消息 nextTextOffset 非空时，用其 source_ref 作为 sourceRef 并传 textOffset 继续读该消息。引用原话和核实矛盾时使用。role=assistant 不是用户事实来源，asr_final 可能误识别。',
      parameters: Type.Object({ sourceRef: Type.Optional(uuid), callId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), after: offset, textOffset: offset }),
      execute: async (_id, p, signal) => {
        signal?.throwIfAborted();
        if (!!p.sourceRef === !!p.callId) throw new Error('Specify sourceRef or callId');
        const value = await memory.source(user, p.sourceRef, p.callId, p.after, p.textOffset); onSource?.(value); return result(value);
      },
    }),
  ];
}
