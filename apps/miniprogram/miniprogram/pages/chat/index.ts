interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  conversationId: string;
  message: ChatMessage & { createdAt: string };
  finishReason: string | null;
}

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
        conversationId: this.data.conversationId || undefined,
      },
      success: ({ data, statusCode }) => {
        if (statusCode < 200 || statusCode >= 300) {
          this.showRequestError('Agent 暂时无法响应，请稍后重试。');
          return;
        }

        this.setData({
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
