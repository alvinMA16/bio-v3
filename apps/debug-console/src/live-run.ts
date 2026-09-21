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
  switch_mode: '切换模式', show_content: '展示内容', update_content: '更新正文', get_content: '读取内容',
  read_document: '读取文稿', edit_document: '修改文稿', show_document: '展示文稿', restore_document: '恢复文稿版本', read_attachment: '读取附件', list_attachments: '查询附件库',
  set_reading_font_size: '调整字号',
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
    case 'run.cancelled': label = `本轮已中断：${({ user_hangup: '通话已结束', user_interrupt: '用户打断', page_hidden: '页面进入后台', client_error: '客户端连接中断', connection_closed: '连接断开', timeout: '生成超时', superseded: '开始新一轮' } as Record<string, string>)[event.reason ?? ''] ?? '请求被取消'}；已写入的草稿会保留`; break;
    case 'run.failed': label = event.message; failed = true; break;
    default: return previous;
  }
  return {
    ...previous, activeTools, ...(panel ? { panel } : {}), status: label,
    steps: [...previous.steps, { sequence: event.sequence, label, elapsedMs, failed }],
  };
}
