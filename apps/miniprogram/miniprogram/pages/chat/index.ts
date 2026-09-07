import { MiniVoiceClient } from '../../lib/voice-client';
let voiceClient: MiniVoiceClient | null = null;
import type { AgentEvent, PanelState } from '@bio/contracts';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  conversationId: string;
  message: ChatMessage & { createdAt: string };
  finishReason: string | null;
  events?: AgentEvent[];
}

Page({
  data: {
    voiceActive: false, voiceStatus: '', voiceTranscript: '', audioPlaying: false,
    input: '',
    sending: false,
    conversationId: '',
    messages: [] as ChatMessage[],
    panel: { mode: 'conversation', revision: 0 } as PanelState,
    selectedBlockId: '',
  },

  startVoice(): void {
    if (this.data.sending || this.data.voiceActive) return;
    this.setData({ voiceActive: true, voiceStatus: '正在连接语音', voiceTranscript: '' });
    voiceClient = new MiniVoiceClient(getApp<IAppOption>().globalData.apiBaseUrl, {
      request: () => {
        const document = this.data.panel.document;
        const selected = document?.blocks.find(block => block.id === this.data.selectedBlockId);
        return {
          ...(this.data.conversationId ? { conversationId: this.data.conversationId } : {}),
          ...(document && selected ? { context: { workspace: { documentId: document.id, version: document.version, selectedBlockId: selected.id, excerpt: selected.text } } } : {}),
        };
      },
      event: event => {
        if (event.type === 'state') this.setData({ voiceStatus: ({ connecting: '正在连接语音', listening: '正在听你说', finalizing: '正在确认识别结果', agent: 'Agent 正在处理', synthesizing: '正在合成语音' })[event.state] });
        if (event.type === 'asr') this.setData({ voiceTranscript: event.text });
        if (event.type === 'transcript') this.setData({ voiceTranscript: '', messages: [...this.data.messages, { id: event.turnId, role: 'user', content: event.text }] });
        if (event.type === 'agent') {
          const item = event.event;
          this.setData({ conversationId: item.conversationId });
          if (item.type === 'panel.state.updated') this.setData({ panel: item.panel, selectedBlockId: '' });
          if (item.type === 'speech.delta' || item.type === 'speech.completed') {
            const existing = this.data.messages.find(message => message.id === item.messageId);
            const message: ChatMessage = { id: item.messageId, role: 'assistant', content: item.type === 'speech.completed' ? item.text : (existing?.content ?? '') + item.delta };
            this.setData({ messages: existing ? this.data.messages.map(value => value.id === message.id ? message : value) : [...this.data.messages, message] });
          }
        }
        if (event.type === 'error') { this.setData({ voiceStatus: event.message }); this.showRequestError(event.message); }
      },
      playback: playing => this.setData({ audioPlaying: playing }),
      error: message => { this.setData({ voiceStatus: message }); this.showRequestError(message); },
      ended: () => { this.setData({ voiceActive: false, audioPlaying: false }); voiceClient = null; },
    });
    voiceClient.start();
  },
  finishVoice(): void { voiceClient?.finish(); },
  interruptVoice(): void { voiceClient?.interrupt(); },
  stopVoice(): void { voiceClient?.close(); },
  onHide(): void { voiceClient?.close(); },
  onUnload(): void { voiceClient?.close(); },

  onInput(event: WechatMiniprogram.Input): void {
    this.setData({ input: event.detail.value });
  },

  selectBlock(event: WechatMiniprogram.TouchEvent): void {
    this.setData({ selectedBlockId: String(event.currentTarget.dataset.id) });
  },

  sendMessage(): void {
    const message = this.data.input.trim();
    if (!message || this.data.sending || this.data.voiceActive) return;

    const document = this.data.panel.document;
    const selected = document?.blocks.find(block => block.id === this.data.selectedBlockId);

    this.setData({
      input: '',
      sending: true,
      messages: [
        ...this.data.messages,
        { id: `user-${Date.now()}`, role: 'user', content: message },
      ],
    });

    wx.request<ChatCompletionResponse>({
      url: `${getApp<IAppOption>().globalData.apiBaseUrl}/chat/completions`,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: {
        message,
        ...(document && selected ? { context: { workspace: {
          documentId: document.id, version: document.version, selectedBlockId: selected.id, excerpt: selected.text,
        } } } : {}),
        conversationId: this.data.conversationId || undefined,
      },
      success: ({ data, statusCode }) => {
        if (statusCode < 200 || statusCode >= 300) {
          this.showRequestError('Agent 暂时无法响应，请稍后重试。');
          return;
        }

        let panel = this.data.panel;
        for (const event of data.events ?? []) {
          if (event.type === 'panel.state.updated') panel = event.panel;
        }
        this.setData({
          panel,
          selectedBlockId: '',
          conversationId: data.conversationId,
          messages: [...this.data.messages, data.message],
        });
      },
      fail: () => this.showRequestError('网络连接失败，请稍后重试。'),
      complete: () => this.setData({ sending: false }),
    });
  },

  showRequestError(message: string): void {
    wx.showToast({ title: message, icon: 'none' });
  },
});
