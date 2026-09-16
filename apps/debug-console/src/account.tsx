import { useEffect, useState, type ReactNode } from 'react';
import './account.css';
import { migrateLegacyOwnerCache } from './account-cache';

const TOKEN_KEY = 'bio-account-token';
const nativeFetch = window.fetch.bind(window);
// Central authentication covers uploads, streams, memory and future HTTP APIs.
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) return nativeFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const token = sessionStorage.getItem('bio-auth-token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await nativeFetch(input, { ...init, headers });
  if (response.status === 401 && token === sessionStorage.getItem('bio-auth-token') && !url.pathname.startsWith('/api/v1/auth/')) window.dispatchEvent(new Event('bio-login-expired'));
  return response;
};
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/v1/auth/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(Array.isArray(result.message) ? result.message.join('，') : result.message || '请求失败，请稍后重试');
  return result;
}
export function AccountBoundary({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'legacy' | 'login' | 'ready' | 'error'>('checking');
  const [phone, setPhone] = useState(''), [code, setCode] = useState('');
  const [user, setUser] = useState<{ id: string; phone: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [retryAt, setRetryAt] = useState(0), [now, setNow] = useState(Date.now());
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  function clear() {
    localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem('bio-auth-token'); sessionStorage.removeItem('bio-account-id');
    setUser(undefined); setPhone(''); setCode(''); setNotice(''); setRetryAt(0); setState('login');
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await api('config');
        if (!active) return;
        if (!config.enabled) { sessionStorage.removeItem('bio-account-enabled'); sessionStorage.removeItem('bio-account-id'); setState('legacy'); return; }
        sessionStorage.setItem('bio-account-enabled', 'true');
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) { clear(); return; }
        sessionStorage.setItem('bio-auth-token', token);
        const response = await fetch('/api/v1/auth/me');
        if (!active) return;
        if (response.status === 401) { clear(); return; }
        if (!response.ok) throw new Error('暂时无法确认登录状态，请重试');
        const value = await response.json();
        migrateLegacyOwnerCache(value.id);
        sessionStorage.setItem('bio-account-id', value.id); setUser(value); setState('ready');
      } catch { if (active) { setError('暂时无法连接服务，请重试'); setState('error'); } }
    })();
    const expired = () => { clear(); setError('登录已过期，请重新登录'); };
    const storage = (event: StorageEvent) => { if (event.key === TOKEN_KEY) location.reload(); };
    window.addEventListener('bio-login-expired', expired); window.addEventListener('storage', storage);
    return () => { active = false; window.removeEventListener('bio-login-expired', expired); window.removeEventListener('storage', storage); };
  }, []);
  useEffect(() => { if (!retryAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [retryAt]);
  async function send() {
    setBusy(true); setError(''); setNotice('');
    try { const result = await api('code', { phone }); setRetryAt(Date.now() + result.retryAfter * 1000); setNow(Date.now()); setNotice('验证码已发送，请查看手机短信'); }
    catch (e) { setError(e instanceof Error ? e.message : '短信发送失败'); }
    finally { setBusy(false); }
  }
  async function login() {
    setBusy(true); setError('');
    try {
      const result = await api('login', { phone, code });
      migrateLegacyOwnerCache(result.user.id);
      localStorage.setItem(TOKEN_KEY, result.token); sessionStorage.setItem('bio-auth-token', result.token);
      sessionStorage.setItem('bio-account-id', result.user.id); setUser(result.user); setCode(''); setState('ready');
    } catch (e) { setError(e instanceof Error ? e.message : '登录失败'); }
    finally { setBusy(false); }
  }
  if (state === 'legacy') return children;
  if (state === 'ready') return <><div className="account-bar"><span>{user?.phone}</span><button disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try { await api('logout', {}); clear(); } catch { setError('退出失败，请重试'); } finally { setBusy(false); }
  }}>退出登录</button>{error && <span role="alert">{error}</span>}</div><div key={user?.id}>{children}</div></>;
  return <main className="account-page"><section className="account-card">
    <div className="account-mark" aria-hidden="true">狸</div><p className="account-eyebrow">令狸 · 你的故事伙伴</p>
    <h1>给你的故事，留一个位置</h1><p className="account-description">登录后，你的聊天、资料和文稿会保存在自己的账号里。</p>
    {state === 'checking' ? <p role="status">正在确认登录状态…</p> : state === 'error' ? <><p role="alert">{error}</p><button onClick={() => location.reload()}>重新连接</button></> :
      <form onSubmit={event => { event.preventDefault(); void login(); }}>
        <label htmlFor="account-phone">手机号</label><div className="account-phone"><span>+86</span><input id="account-phone" type="tel" autoComplete="tel-national" inputMode="numeric" maxLength={11} placeholder="请输入手机号" value={phone} disabled={busy} onChange={e => { setPhone(e.target.value.replace(/\D/g, '')); setCode(''); }} /></div>
        <label htmlFor="account-code">短信验证码</label><div className="account-code"><input id="account-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="六位验证码" value={code} disabled={busy} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /><button type="button" disabled={busy || cooldown > 0 || !/^1[3-9]\d{9}$/.test(phone)} onClick={() => void send()}>{cooldown ? `${cooldown} 秒后重发` : '获取验证码'}</button></div>
        {error && <p className="account-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        <button className="account-submit" disabled={busy || !/^1[3-9]\d{9}$/.test(phone) || !/^\d{6}$/.test(code)}>{busy ? '请稍候…' : '登录，开始记录'}</button>
        <p className="account-note">首次验证成功会自动创建账号</p>
      </form>}
  </section></main>;
}
