/**
 * 认证页 Pxx-AUTH（D01 §3 认证窗 420×560）：
 * 账号口令表单；1007 错误锁定倒计时展示；错误文案按错误码映射（D01 §11）。
 */

import { useEffect, useState } from 'react';
import { Button, Form, Input } from 'antd';
import { Navigate } from 'react-router-dom';
import { getErrorText } from '../../../shared/api/http';
import { Logo } from '../../../shared/ui/Logo';
import { useAuthStore } from '../store/auth';
import { apiSetupStatus } from '../api/auth';

/** 锁定剩余秒数（每秒心跳刷新） */
function useLockCountdown(lockUntil: number): number {
  const [now, setNow] = useState(() => Date.now());
  const active = lockUntil > now;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return Math.max(0, Math.ceil((lockUntil - now) / 1000));
}

export function LoginPage() {
  const token = useAuthStore((s) => s.token);
  const loginStatus = useAuthStore((s) => s.loginStatus);
  const error = useAuthStore((s) => s.error);
  const lockUntil = useAuthStore((s) => s.lockUntil);
  const login = useAuthStore((s) => s.login);

  const lockSecondsLeft = useLockCountdown(lockUntil);
  const locked = lockSecondsLeft > 0;

  // 空系统检测：未初始化 → 初始化向导（16 篇 §2.2；探测失败静默留在登录页）
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    let alive = true;
    apiSetupStatus()
      .then((s) => alive && setNeedsSetup(!s.initialized))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 已登录（含登录成功）→ 回默认落点 /im
  if (token) return <Navigate to="/im" replace />;
  if (needsSetup) return <Navigate to="/setup" replace />;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__brand">
          <Logo size={44} />
          <div className="login-card__title">BaobaoWork</div>
          <div className="login-card__sub">让协作更简单 · 企业协作工作台</div>
        </div>

        <Form
          layout="vertical"
          className="login-card__form"
          disabled={locked}
          onFinish={(values) => void login(String(values.account ?? ''), String(values.password ?? ''))}
        >
          <Form.Item name="account" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input placeholder="请输入账号" autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item name="password" label="口令" rules={[{ required: true, message: '请输入口令' }]}>
            <Input.Password placeholder="请输入口令" autoComplete="current-password" size="large" />
          </Form.Item>

          {/* 错误码→中文文案（不依赖服务端 message） */}
          {error && !locked ? <div className="login-card__error">{getErrorText(error.code)}</div> : null}
          {/* 1007 错误锁定倒计时 */}
          {locked ? (
            <div className="login-card__countdown">失败次数过多已锁定，{lockSecondsLeft} 秒后可重试</div>
          ) : null}

          <Button block size="large" htmlType="submit" loading={loginStatus === 'submitting'} disabled={locked} className="login-card__submit">
            登 录
          </Button>
        </Form>

        <div className="login-card__footer">
          SSO / MFA 登录入口在后续阶段接入（03 篇）
          <br />© 2026 BaobaoWork
        </div>
      </div>
    </div>
  );
}
