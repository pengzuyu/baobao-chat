/**
 * 认证页 Pxx-AUTH（D01 §3 认证窗 420×560）：
 * 2026-11-12：账号改为搜人选择（工号/拼音/名字模糊检索下拉——选中自动填充工号，
 * 不再手填；卡片带工号/姓名/组织链路，滚动分页按工号排序）。
 * M4（2026-11-12 用户裁决）：增自助注册——姓名+自设口令，工号服务端自动生成
 * （拼音基名+重名递增），成功回执展示工号后回登录页（不自动登录）；注册用户
 * 默认落虚拟「未分组」，由管理员后续调整归属。
 * 1007 错误锁定倒计时展示；错误文案按错误码映射（D01 §11）。
 * D11：登录命中 must_change_pwd（导入用户初始口令）→ 二步改密表单
 * （token 已发但被本页拦截，改密成功才放行进应用）。
 * D26-O3：login-page/login-card 自研壳退役——居中布局内联 + antd Card，
 * 错误/锁定提示→Alert、回车提交→onPressEnter；登录/注册/搜人逻辑不动。
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography } from 'antd';
import { Navigate } from 'react-router-dom';
import { errText, getErrorText } from '../../../shared/api/http';
import { Logo } from '../../../shared/ui/Logo';
import { APP_NAME, COPYRIGHT, MAIL_DOMAIN, TAGLINE } from '../../../shared/brand';
import { useAuthStore } from '../store/auth';
import { apiRegister, apiSetupStatus, type UserCard } from '../api/auth';
import { UserPicker } from '../components/UserPicker';

/** 认证页居中壳 + 品牌区（D26-O3 内联化）
 *  2026-11-23 真机：外壳不再随文档滚动，认证页改用 height:100% + 自身 overflowY，
 *  卡片用 margin:auto 居中（窗口矮时从顶部开始、可滚到底，不会把卡片上半截裁掉） */
const AUTH_PAGE_STYLE: CSSProperties = { height: '100%', overflowY: 'auto', display: 'flex', padding: 16 };

function AuthBrand({ title, sub }: { title: string; sub: string }) {
  return (
    <Flex vertical align="center" gap={4} style={{ textAlign: 'center', marginBottom: 20 }}>
      <Logo size={44} />
      <Typography.Title level={4} style={{ margin: '8px 0 0' }}>
        {title}
      </Typography.Title>
      <Typography.Text type="secondary">{sub}</Typography.Text>
    </Flex>
  );
}

function AuthFooter({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', fontSize: 12, marginTop: 16 }}>
      {children}
    </Typography.Text>
  );
}

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

  // 自助注册（M4）：login=登录 / register=注册表单 / registered=成功回执（展示工号）
  const [mode, setMode] = useState<'login' | 'register' | 'registered'>('login');
  const [regName, setRegName] = useState('');
  const [regPwd, setRegPwd] = useState('');
  const [regPwd2, setRegPwd2] = useState('');
  const [regBusy, setRegBusy] = useState(false);
  const [regError, setRegError] = useState('');
  const [registeredEmpno, setRegisteredEmpno] = useState('');
  const [registeredEmail, setRegisteredEmail] = useState('');

  const submitRegister = async () => {
    if (regBusy) return;
    const name = regName.trim();
    if (!name || name.length > 50) {
      setRegError('请输入姓名（≤50 字）');
      return;
    }
    if (regPwd.length < 8 || !/[a-zA-Z]/.test(regPwd) || !/[0-9]/.test(regPwd)) {
      setRegError('密码至少 8 位且须同时包含字母与数字');
      return;
    }
    if (regPwd !== regPwd2) {
      setRegError('两次输入的密码不一致');
      return;
    }
    setRegBusy(true);
    setRegError('');
    try {
      const result = await apiRegister(name, regPwd);
      setRegisteredEmpno(result.employee_no);
      setRegisteredEmail(result.email);
      setMode('registered');
    } catch (e) {
      setRegError(errText(e, '注册失败，请稍后重试'));
    } finally {
      setRegBusy(false);
    }
  };

  /** 回执「去登录」：预填刚注册的账号（直接输口令即可登录） */
  const backToLogin = () => {
    setPicked({ employee_no: registeredEmpno, display_name: regName.trim(), org_path: '' });
    setMode('login');
  };

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
      <div style={AUTH_PAGE_STYLE}>
        <Card style={{ width: 360 }}>
          <AuthBrand title="首次登录 · 修改密码" sub="初始口令为临时口令，请设置新密码后进入" />
          <Form layout="vertical">
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
                onPressEnter={() => oldPwd && newPwd && submitChange()}
              />
            </Form.Item>
            {pwdError ? <Alert type="error" showIcon message={pwdError} data-testid="must-change-error" style={{ marginBottom: 16 }} /> : null}
            <Button block size="large" loading={pwdBusy} disabled={!oldPwd || !newPwd || !newPwd2} onClick={submitChange} data-testid="must-change-submit">
              设置新密码并进入
            </Button>
          </Form>
        </Card>
      </div>
    );
  }

  // 已登录（含登录成功）→ 回默认落点 /im
  if (token) return <Navigate to="/im" replace />;
  if (needsSetup) return <Navigate to="/setup" replace />;

  // 注册成功回执（M4）：工号即登录账号——牢记后回登录（预填账号直接输口令）
  if (mode === 'registered') {
    return (
      <div style={AUTH_PAGE_STYLE}>
        <Card style={{ width: 360 }}>
          <AuthBrand title="注册成功" sub="请牢记你的工号（登录账号）" />
          <Typography.Text code data-testid="register-empno" style={{ display: 'block', textAlign: 'center', fontSize: 22, marginBottom: 4 }}>
            {registeredEmpno}
          </Typography.Text>
          <Typography.Text code data-testid="register-email" type="secondary" style={{ display: 'block', textAlign: 'center', marginBottom: 8 }}>
            {registeredEmail}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', marginBottom: 16 }}>
            你已加入「未分组」，所属组织可由管理员后续调整
          </Typography.Text>
          <Button block size="large" onClick={backToLogin} data-testid="register-goto-login">
            去登录
          </Button>
        </Card>
      </div>
    );
  }

  // 自助注册表单（M4）：姓名+口令，工号服务端自动分配（拼音基名+重名递增）
  if (mode === 'register') {
    return (
      <div style={AUTH_PAGE_STYLE}>
        <Card style={{ width: 360 }}>
          <AuthBrand title="注册账号" sub="姓名 + 口令即可，工号将自动分配" />
          <Form layout="vertical">
            <Form.Item label="姓名" extra={`邮箱将自动生成为 工号@${MAIL_DOMAIN}（与工号一并展示）`}>
              <Input
                placeholder="真实姓名（用于通讯录与搜索）"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                size="large"
                autoFocus
                maxLength={50}
                data-testid="register-name"
              />
            </Form.Item>
            <Form.Item label="密码（≥8 位，含字母与数字）">
              <Input.Password value={regPwd} onChange={(e) => setRegPwd(e.target.value)} size="large" autoComplete="new-password" />
            </Form.Item>
            <Form.Item label="确认密码">
              <Input.Password
                value={regPwd2}
                onChange={(e) => setRegPwd2(e.target.value)}
                size="large"
                autoComplete="new-password"
                onPressEnter={() => regName && regPwd && void submitRegister()}
              />
            </Form.Item>
            {regError ? <Alert type="error" showIcon message={regError} data-testid="register-error" style={{ marginBottom: 16 }} /> : null}
            <Button
              block
              size="large"
              loading={regBusy}
              disabled={!regName.trim() || !regPwd || !regPwd2}
              onClick={() => void submitRegister()}
              data-testid="register-submit"
            >
              注 册
            </Button>
            <div style={{ textAlign: 'center', marginTop: 12, fontSize: 13 }}>
              <Typography.Text type="secondary">已有账号？</Typography.Text>{' '}
              <Typography.Link onClick={() => setMode('login')} data-testid="register-back-login">
                返回登录
              </Typography.Link>
            </div>
          </Form>
        </Card>
      </div>
    );
  }

  return (
    <div style={AUTH_PAGE_STYLE}>
      <Card style={{ width: 360, margin: 'auto' }}>
        <AuthBrand title={APP_NAME} sub={TAGLINE} />

        <Form
          layout="vertical"
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
          <Form.Item label="账号">
            <UserPicker selected={picked} onSelect={setPicked} disabled={locked} />
            {pickError ? <Alert type="error" showIcon message={pickError} data-testid="login-pick-error" style={{ marginTop: 8 }} /> : null}
          </Form.Item>
          <Form.Item name="password" label="口令" rules={[{ required: true, message: '请输入口令' }]}>
            <Input.Password placeholder="请输入口令" autoComplete="current-password" size="large" />
          </Form.Item>

          {/* 错误码→中文文案（不依赖服务端 message） */}
          {error && !locked ? <Alert type="error" showIcon message={getErrorText(error.code)} style={{ marginBottom: 8 }} /> : null}
          {/* 1007 错误锁定倒计时 */}
          {locked ? (
            <Alert type="warning" showIcon message={`失败次数过多已锁定，${lockSecondsLeft} 秒后可重试`} style={{ marginBottom: 8 }} />
          ) : null}

          <Button block size="large" htmlType="submit" loading={loginStatus === 'submitting'} disabled={locked}>
            登 录
          </Button>

          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 13 }}>
            <Typography.Text type="secondary">还没有账号？</Typography.Text>{' '}
            <Typography.Link onClick={() => setMode('register')} data-testid="goto-register">
              注册
            </Typography.Link>
          </div>
        </Form>

        <AuthFooter>
          SSO / MFA 登录入口在后续阶段接入（03 篇）
          <br />{COPYRIGHT}
        </AuthFooter>
      </Card>
    </div>
  );
}
