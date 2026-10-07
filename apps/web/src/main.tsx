import React from 'react';
import ReactDOM from 'react-dom/client';
import { bootstrapRuntimeContext } from '@/lib/runtime-context';

// 主题恢复（在 React 渲染前执行，避免暗色用户看到白屏闪烁）
try {
  const saved = localStorage.getItem('opg-theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  if (saved === 'dark' || (!saved && prefersDark)) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
} catch { /* localStorage 不可用时忽略 */ }

async function start() {
  await bootstrapRuntimeContext();
  const { default: App } = await import('./App');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();

