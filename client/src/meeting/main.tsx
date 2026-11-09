/**
 * 会议窗口入口（meeting.html，D17 §4）：轻量壳——不加载主应用路由/IM/全局 store，
 * 仅挂 MeetingWindow（handoff → 自治通话）。样式与主入口共享 tokens/global。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MeetingWindow } from '../features/rtc/meeting/MeetingWindow';
import '../styles/tokens.css';
import '../styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('缺少 #root 挂载点');

createRoot(rootEl).render(
  <StrictMode>
    <MeetingWindow />
  </StrictMode>,
);
