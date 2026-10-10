import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { AccountBoundary } from './account';
import './styles.css';

const internal = /^\/internal(?:\/|$)/.test(window.location.pathname);
document.documentElement.dataset.surface = internal ? 'internal' : 'product';
document.title = internal ? '令狸 Agent Lab' : '令狸 · 你的故事伙伴';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AccountBoundary showAccountBar={internal}><App internal={internal} /></AccountBoundary>
  </StrictMode>,
);
