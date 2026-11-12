/**
 * 认证页 Pxx-AUTH（D01 §3 认证窗 420×560）：
 * 2026-11-12：账号改为搜人选择（工号/拼音/名字模糊检索下拉——选中自动填充工号，
 * 不再手填；卡片带工号/姓名/组织链路，滚动分页按工号排序）。
 * 1007 错误锁定倒计时展示；错误文案按错误码映射（D01 §11）。
 * D11：登录命中 must_change_pwd（导入用户初始口令）→ 二步改密表单
 * （token 已发但被本页拦截，改密成功才放行进应用）。
 */

import { useEffect, useState } from 'react';
import { Button, Form, Input } from 'antd';
import { Navigate } from 'react-router-dom';
import { getErrorText } from '../../../shared/api/http';
import { Logo } from '../../../shared/ui/Logo';
import { useAuthStore } from '../store/auth';
import { apiSetupStatus, type UserCard } from '../api/auth';
import { UserPicker } from '../components/UserPicker';

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

  // 搜人选账号（2026-11-12）：下拉选中后自动填充工号，不再手填
  const [picked, setPicked] = useState<UserCard | null>(null);
  const [pickError, setPickError] = useState('');

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

  // 首登强制改密（D11）：token 已发但拦截在本页——改密成功才放行
  const user = useAuthStore((s) => s.user);
  const changePassword = useAuthStore((s) => s.changePassword);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdError, setPwdError] = useState('');

  if (token && user?.must_change_pwd) {
    const submitChange = () => {
      if (newPwd.length < 8) {
        setPwdError('新密码至少 8 位（含字母与数字）');
        return;
      }
      if (newPwd !== newPwd2) {
        setPwdError('两次输入的新密码不一致');
        return;
      }
      setPwdBusy(true);
      setPwdError('');
      void changePassword(oldPwd, newPwd)
        .catch((e) => setPwdError(e instanceof Error ? e.message : '改密失败，请重试'))
        .finally(() => setPwdBusy(false));
    };
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-card__brand">
            <Logo size={44} />
            <div className="login-card__title">首次登录 · 修改密码</div>
            <div className="login-card__sub">初始口令为临时口令，请设置新密码后进入</div>
          </div>
          <Form layout="vertical" className="login-card__form">
            <Form.Item label="当前口令（初始口令）">
              <Input.Password value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} size="large" autoFocus />
            </Form.Item>
            <Form.Item label="新密码（≥8 位，含字母与数字）">
              <Input.Password value={newPwd} onChange={(e) => setNewPwd(e.target.value)} size="large" />
            </Form.Item>
            <Form.Item label="确认新密码">
              <Input.Password
                value={newPwd2}
                onChange={(e) => setNewPwd2(e.target.value)}
                size="large"
                onKeyDown={(e) => e.key === 'Enter' && oldPwd && newPwd && submitChange()}
              />
            </Form.Item>
            {pwdError ? <div className="login-card__error" data-testid="must-change-error">{pwdError}</div> : null}
            <Button block size="large" className="login-card__submit" loading={pwdBusy} disabled={!oldPwd || !newPwd || !newPwd2} onClick={submitChange} data-testid="must-change-submit">
              设置新密码并进入
            </Button>
          </Form>
        </div>
      </div>
    );
  }

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
          onFinish={(values) => {
            if (!picked) {
              setPickError('请先搜索并选择账号');
              return;
            }
            setPickError('');
            void login(picked.employee_no, String(values.password ?? ''));
          }}
        >
          <div className="login-card__field">
            <label className="login-card__label">账号</label>
            <UserPicker selected={picked} onSelect={setPicked} disabled={locked} />
            {pickError ? <div className="login-card__error" data-testid="login-pick-error">{pickError}</div> : null}
          </div>
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
