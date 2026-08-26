interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

type StreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'delta'; content: string }
  | { type: 'done'; finishReason: string | null }
  | { type: 'error'; code: string; message: string };

Page({
  data: {
    input: '',
    sending: false,
    conversationId: '',
    messages: [] as ChatMessage[],
  },

  onInput(event: WechatMiniprogram.Input): void {
    this.setData({ input: event.detail.value });
  },

  sendMessage(): void {
    const message = this.data.input.trim();
    if (!message || this.data.sending) return;

    const assistantId = `assistant-${Date.now()}`;
    this.setData({
      input: '',
      sending: true,
      messages: [
        ...this.data.messages,
        { id: `user-${Date.now()}`, role: 'user', content: message },
        { id: assistantId, role: 'assistant', content: '' },
      ],
    });

    let buffer = '';
    const request = wx.request({
      url: `${getApp<IAppOption>().globalData.apiBaseUrl}/chat/stream`,
      method: 'POST',
      enableChunked: true,
      header: { 'content-type': 'application/json' },
      data: {
        message,
        conversationId: this.data.conversationId || undefined,
      },
      fail: () => this.failMessage(assistantId, '网络连接失败，请稍后重试。'),
      complete: () => this.setData({ sending: false }),
    });

    request.onChunkReceived(({ data }) => {
      buffer += this.decodeChunk(data);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        this.applyStreamEvent(assistantId, JSON.parse(line) as StreamEvent);
      }
    });
  },

  decodeChunk(data: ArrayBuffer): string {
    const bytes = new Uint8Array(data);
    return decodeURIComponent(
      Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    );
  },

  applyStreamEvent(assistantId: string, event: StreamEvent): void {
    if (event.type === 'start') {
      this.setData({ conversationId: event.conversationId });
      return;
    }
    if (event.type === 'delta') {
      const messages = this.data.messages.map((item) =>
        item.id === assistantId
          ? { ...item, content: item.content + event.content }
          : item,
      );
      this.setData({ messages });
      return;
    }
    if (event.type === 'error') this.failMessage(assistantId, event.message);
  },

  failMessage(assistantId: string, message: string): void {
    const messages = this.data.messages.map((item) =>
      item.id === assistantId ? { ...item, content: message } : item,
    );
    this.setData({ messages, sending: false });
  },
});
