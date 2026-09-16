import { authRequest, clearAccount } from '../../lib/account';
import { migrateLegacyOwnerReceipt } from '../../lib/session-receipt';
Page({
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  retryAt: 0,
  data: { phone: '', code: '', busy: false, error: '', notice: '', cooldown: 0, accountPhone: '' },
  onLoad() { this.setData({ accountPhone: wx.getStorageSync('bio-account-phone') || '' }); },
  onUnload() { clearInterval(this.timer); },
  phoneInput(event: WechatMiniprogram.Input) { this.setData({ phone: event.detail.value.replace(/\D/g, ''), code: '' }); },
  codeInput(event: WechatMiniprogram.Input) { this.setData({ code: event.detail.value.replace(/\D/g, '') }); },
  async send() {
    if (this.data.busy || this.data.cooldown) return;
    if (!/^1[3-9]\d{9}$/.test(this.data.phone)) { this.setData({ error: '请输入正确的中国大陆手机号' }); return; }
    this.setData({ busy: true, error: '', notice: '' });
    try {
      const result = await authRequest<{ retryAfter: number }>('code', { phone: this.data.phone });
      this.retryAt = Date.now() + result.retryAfter * 1000;
      this.setData({ cooldown: result.retryAfter, notice: '验证码已发送，请查看手机短信' });
      clearInterval(this.timer); this.timer = setInterval(() => { const cooldown = Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000)); this.setData({ cooldown }); if (!cooldown) clearInterval(this.timer); }, 1000);
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : '短信发送失败' }); }
    finally { this.setData({ busy: false }); }
  },
  async login() {
    if (this.data.busy) return;
    if (!/^1[3-9]\d{9}$/.test(this.data.phone) || !/^\d{6}$/.test(this.data.code)) { this.setData({ error: '请输入手机号和六位验证码' }); return; }
    this.setData({ busy: true, error: '' });
    try {
      const result = await authRequest<{ token: string; user: { id: string; phone: string } }>('login', { phone: this.data.phone, code: this.data.code });
      migrateLegacyOwnerReceipt(result.user.id);
      clearAccount(); wx.setStorageSync('bio-auth-token', result.token); wx.setStorageSync('bio-account-id', result.user.id); wx.setStorageSync('bio-account-phone', result.user.phone);
      wx.reLaunch({ url: '/pages/character/index' });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : '登录失败' }); }
    finally { this.setData({ busy: false }); }
  },
  async logout() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await authRequest('logout', {}); clearAccount(); this.setData({ accountPhone: '', code: '' }); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : '退出失败，请重试' }); }
    finally { this.setData({ busy: false }); }
  },
  home() { wx.reLaunch({ url: '/pages/character/index' }); },
});
