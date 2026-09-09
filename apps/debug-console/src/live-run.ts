import type { AgentEvent, PanelState } from '@bio/contracts';

export interface LiveRun {
  messages: { id: string; text: string; completed: boolean }[];
  steps: { sequence: number; label: string; elapsedMs: number; failed: boolean }[];
  panel?: PanelState;
  activeTools?: { id: string; name: string }[];
  status: string;
}

export function emptyLiveRun(): LiveRun {
  return { messages: [], steps: [], status: '正在连接 Agent' };
}

const toolLabels: Record<string, string> = {
  // Old persisted traces remain readable; only the new names are exposed to the model.
  set_panel_mode: '展示内容', update_panel_content: '更新正文', get_panel_state: '读取内容',
  show_content: '展示内容', update_content: '更新正文', get_content: '读取内容',
};

export function applyLiveEvent(previous: LiveRun, event: AgentEvent, elapsedMs: number): LiveRun {
  if (event.type === 'speech.delta' || event.type === 'speech.completed') {
    const existing = previous.messages.find(message => message.id === event.messageId);
    const message = {
      id: event.messageId,
      text: event.type === 'speech.delta' ? (existing?.text ?? '') + event.delta : event.text,
      completed: event.type === 'speech.completed',
    };
    return { ...previous, status: event.type === 'speech.delta' ? '令狸正在回复' : previous.status, messages: existing
      ? previous.messages.map(item => item.id === message.id ? message : item)
      : [...previous.messages, message],
    };
  }
  let activeTools = previous.activeTools ?? [];
  if (event.type === 'tool.started') activeTools = [...activeTools.filter(tool => tool.id !== event.toolCallId), { id: event.toolCallId, name: event.name }];
  if (event.type === 'tool.completed') activeTools = activeTools.filter(tool => tool.id !== event.toolCallId);
  if (['run.completed', 'run.cancelled', 'run.failed'].includes(event.type)) activeTools = [];
  let label: string;
  let failed = false;
  let panel = previous.panel;
  switch (event.type) {
    case 'run.started': label = '正在处理请求'; break;
    case 'tool.started': label = `正在${toolLabels[event.name] ?? event.name}`; break;
    case 'tool.completed':
      failed = event.isError;
      label = `${toolLabels[event.name] ?? event.name}${failed ? '失败' : '完成'}`;
      break;
    case 'panel.state.updated':
      panel = event.panel;
      label = panel.mode === 'conversation' ? '内容：纯对话'
        : panel.mode === 'attachment' ? `内容：查看 ${panel.attachment?.title ?? '附件'}`
        : `内容：${panel.document?.title ?? '草稿'} · 版本 ${panel.document?.version ?? 0}`;
      break;
    case 'context.compacting': label = '正在整理对话上下文'; break;
    case 'context.compacted': label = '对话上下文已整理'; break;
    case 'run.completed': label = '本轮完成'; break;
    case 'run.cancelled': label = '本轮已取消'; break;
    case 'run.failed': label = event.message; failed = true; break;
    default: return previous;
  }
  return {
    ...previous, activeTools, ...(panel ? { panel } : {}), status: label,
    steps: [...previous.steps, { sequence: event.sequence, label, elapsedMs, failed }],
  };
}
