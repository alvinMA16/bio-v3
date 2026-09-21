import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { READING_FONT_SIZES, adjustReadingFontSize, type AgentEventPayload } from '@bio/contracts';
import type { AgentStorage } from './agent-storage.js';

export function readingFontTool(storage: AgentStorage, user: string | undefined, emit: (event: AgentEventPayload) => void, supported = true) {
  return defineTool({
    name: 'set_reading_font_size', label: '调整阅读字号',
    description: '调整用户的阅读字号，不修改文稿正文。五档从小到大：小号、较小、标准、较大、大号；默认标准，比原字号略小。用户说字小一点/大一点，分别用调小/调大，每次只移动一档；也可指定档位或恢复默认。按当前用户持久保存，下次打开与新会话沿用。到边界不再变化，明确告知已经最小/最大。适用于文稿和普通对话文字，不缩放图片、PDF原件或整个页面。只在用户要求调整时调用；“不要调小”等否定表达不是调整授权，不调用。',
    parameters: Type.Object({ size: Type.Union([...READING_FONT_SIZES, '调小', '调大', '恢复默认'].map(value => Type.Literal(value))) }),
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      if (!supported) throw new Error('当前页面尚不支持实时字号调整。设置未改变；请用户结束通话并刷新页面后重试，不声称已经调好。');
      const previous = storage.readingFontSize(user);
      const fontSize = adjustReadingFontSize(previous, params.size);
      storage.saveReadingFontSize(fontSize, user);
      emit({ type: 'reading.preference.updated', fontSize, previousFontSize: previous });
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'saved', previous, fontSize, changed: previous !== fontSize,
        note: previous === fontSize ? `当前已经是${fontSize}，没有继续改变。` : `字号设置已保存并下发。简短告知“已从${previous}调为${fontSize}”。仅改变显示，不修改正文。` }) }], details: {} };
    },
  });
}
