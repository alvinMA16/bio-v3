import { clearReceipt, migrateLegacyOwnerReceipt } from './session-receipt';
export function authHeader(): Record<string, string> {
  const token = wx.getStorageSync('bio-auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export function clearAccount(): void {
  clearReceipt();
  wx.removeStorageSync('bio-auth-token'); wx.removeStorageSync('bio-account-id'); wx.removeStorageSync('bio-account-phone');
}
export function authRequest<T>(path: string, data?: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => wx.request({ url: `${getApp<IAppOption>().globalData.apiBaseUrl}/auth/${path}`,
    method: data ? 'POST' : 'GET', ...(data ? { data } : {}), header: authHeader(),
    success: response => {
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data as T);
      else { if (path === 'me' && response.statusCode === 401) clearAccount(); const body = response.data as { message?: string | string[] }; reject(new Error(Array.isArray(body.message) ? body.message.join('，') : body.message || '请求失败，请重试')); }
    }, fail: () => reject(new Error('网络连接失败，请重试')),
  }));
}
export async function requireAccount(): Promise<boolean> {
  try {
    const config = await authRequest<{ enabled: boolean }>('config');
    if (!config.enabled) return true;
    if (wx.getStorageSync('bio-auth-token')) {
      const user = await authRequest<{ id: string; phone: string }>('me');
      migrateLegacyOwnerReceipt(user.id);
      wx.setStorageSync('bio-account-id', user.id); wx.setStorageSync('bio-account-phone', user.phone); return true;
    }
  } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : '请重新登录', icon: 'none' }); }
  wx.reLaunch({ url: '/pages/login/index' }); return false;
}
export function handleUnauthorized(status: number): void {
  if (status !== 401) return;
  clearAccount(); wx.reLaunch({ url: '/pages/login/index' });
}
