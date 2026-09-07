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
    input: '',
    sending: false,
    conversationId: '',
    messages: [] as ChatMessage[],
    panel: { mode: 'conversation', revision: 0 } as PanelState,
    selectedBlockId: '',
  },

  onInput(event: WechatMiniprogram.Input): void {
    this.setData({ input: event.detail.value });
  },

  selectBlock(event: WechatMiniprogram.TouchEvent): void {
    this.setData({ selectedBlockId: String(event.currentTarget.dataset.id) });
  },

  sendMessage(): void {
    const message = this.data.input.trim();
    if (!message || this.data.sending) return;

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
