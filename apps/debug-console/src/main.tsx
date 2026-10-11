import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { AccountBoundary } from './account';
import './styles.css';
const AdminApp = lazy(() => import('./admin').then(module => ({ default: module.AdminApp })));

const internal = /^\/internal(?:\/|$)/.test(window.location.pathname);
const admin = /^\/admin(?:\/|$)/.test(window.location.pathname);
document.documentElement.dataset.surface = admin ? 'admin' : internal ? 'internal' : 'product';
document.title = admin ? '令狸管理台' : internal ? '令狸 Agent Lab' : '令狸 · 你的故事伙伴';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AccountBoundary showAccountBar={internal || admin} purpose={admin ? 'admin' : 'product'}>{admin ? <Suspense fallback={<p role="status">正在打开管理台…</p>}><AdminApp/></Suspense> : <App internal={internal} />}</AccountBoundary>
  </StrictMode>,
);
