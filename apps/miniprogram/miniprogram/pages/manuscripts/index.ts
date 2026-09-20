import type { PanelDocument } from '@bio/contracts';
import { requireAccount, handleUnauthorized } from '../../lib/account';
type Entry = { conversationId: string; id: string; title: string; version: number };
Page({
  unloaded: false,
  generation: 0,
  data: { items: [] as Entry[], document: null as PanelDocument | null, loading: true, error: '' },
  async onLoad() { if (await requireAccount()) this.load(''); },
  onUnload() { this.unloaded = true; },
  load(path: string) {
    const generation = ++this.generation;
    this.setData({ loading: true, error: '' });
    const token = wx.getStorageSync('bio-auth-token');
    wx.request({ url: `${getApp<IAppOption>().globalData.apiBaseUrl}/agent/manuscripts${path}`, header: token ? { Authorization: `Bearer ${token}` } : {},
      success: response => { handleUnauthorized(response.statusCode); if (this.unloaded || this.generation !== generation) return; if (response.statusCode !== 200) { this.setData({ error: '无法读取文稿，请返回列表重试。' }); return; } this.setData(path ? { document: response.data as PanelDocument } : { items: response.data as Entry[], document: null }); },
      fail: () => { if (!this.unloaded && this.generation === generation) this.setData({ error: '网络连接失败，请重试。' }); },
      complete: () => { if (!this.unloaded && this.generation === generation) this.setData({ loading: false }); },
    });
  },
  select(event: WechatMiniprogram.TouchEvent) { const item = this.data.items[event.currentTarget.dataset.index]; if (item) this.load(`/${encodeURIComponent(item.conversationId)}/${encodeURIComponent(item.id)}`); },
  back() { this.load(''); },
  chat() {
    if (this.data.document) wx.navigateTo({ url: `/pages/chat/index?mode=call&documentId=${encodeURIComponent(this.data.document.id)}` });
  },
});
