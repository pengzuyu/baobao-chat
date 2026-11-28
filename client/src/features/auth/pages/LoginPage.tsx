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
 * 2026-11-26：注册/回执/首登改密三卡补 margin:auto 与登录卡对齐（此前仅登录卡居中）；
 * 注册表单工号/邮箱从 extra 提示改为框内动态只读预览——输入姓名防抖取服务端
 * /auth/empno-preview（真实查重递增，预览不占用，注册以回执为准），生僻字降级占位。
 * 2026-11-27：QQ 式登录改造——账号框回归受控文本（手输/自动填充可直接登录），
 * AccountPicker 下拉=「最近登录」历史账号+组织搜索二段式；记住密码/自动登录双复选框
 * （默认双勾保持旧版重开直达；自动登录全局互斥、登录即重申，勾选联动记住密码），
 * 挂载预填最近账号与记住的口令；首登改密成功同步新口令进本地记忆。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Alert, Button, Card, Checkbox, Flex, Form, Input, Typography } from 'antd';
import type { InputRef } from 'antd';
import { Navigate } from 'react-router-dom';
import { errText, getErrorText } from '../../../shared/api/http';
import { Logo } from '../../../shared/ui/Logo';
import { APP_NAME, COPYRIGHT, TAGLINE } from '../../../shared/brand';
import { useAuthStore } from '../store/auth';
import { apiEmpnoPreview, apiRegister, apiSetupStatus, type RegisterResult, type UserCard } from '../api/auth';
import { AccountPicker } from '../components/AccountPicker';
import { authAccountsList, authAccountsRemove, authLoginPasswordGet, authLoginPasswordSet, type RememberedAccount } from '../bridge/accounts';

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

  // 账号：受控文本 + 可选选中组织用户（手输工号/邮箱/手机号可直接登录，自动填充可感知）
  const [account, setAccount] = useState('');
  const [picked, setPicked] = useState<UserCard | null>(null);
  const [pickError, setPickError] = useState('');

  // QQ 式账号记忆（2026-11-27）：历史账号 + 记住密码/自动登录双开关。
  // 默认双勾=保持旧版「登录过重开直达」体验；升级迁移见 store.restoreLogin
  const [remembered, setRemembered] = useState<RememberedAccount[]>([]);
  const [rememberPwd, setRememberPwd] = useState(true);
  const [autoLogin, setAutoLogin] = useState(true);
  const [form] = Form.useForm();
  const passwordRef = useRef<InputRef>(null);

  /** 选历史账号：填账号文本与勾选态；记住密码则回填口令（无存证焦点进口令框） */
  const pickRemembered = async (a: RememberedAccount) => {
    setAccount(a.account);
    setPicked({ employee_no: a.account, display_name: a.name || a.account, org_path: '' });
    setRememberPwd(a.rememberPwd);
    setAutoLogin(a.autoLogin);
    setPickError('');
    const pwd = a.rememberPwd ? await authLoginPasswordGet(a.account).catch(() => null) : null;
    if (pwd) {
      form.setFieldValue('password', pwd);
    } else {
      passwordRef.current?.focus();
    }
  };

  /** 删除历史账号（本地记忆+钥匙串口令一并清）；删的是当前选中账号则清空表单防误用 */
  const removeRemembered = (a: RememberedAccount) => {
    void authAccountsRemove(a.account).catch(() => undefined);
    setRemembered((prev) => prev.filter((x) => x.account !== a.account));
    if ((picked?.employee_no ?? account.trim()) === a.account) {
      setPicked(null);
      setAccount('');
      form.setFieldValue('password', undefined);
    }
  };

  // 挂载预填（QQ 行为，仅 Tauri 有记忆）：最近账号 + 记住的口令 + 该账号的开关勾选态
  useEffect(() => {
    let alive = true;
    authAccountsList()
      .then(async (list) => {
        if (!alive || list.length === 0) return;
        const last = list[0];
        setRemembered(list);
        setAccount(last.account);
        setPicked({ employee_no: last.account, display_name: last.name || last.account, org_path: '' });
        setRememberPwd(last.rememberPwd);
        setAutoLogin(last.autoLogin);
        if (last.rememberPwd) {
          const pwd = await authLoginPasswordGet(last.account).catch(() => null);
          if (alive && pwd) form.setFieldValue('password', pwd);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [form]);

  // 自助注册（M4）：login=登录 / register=注册表单 / registered=成功回执（展示工号）
  const [mode, setMode] = useState<'login' | 'register' | 'registered'>('login');
  const [regName, setRegName] = useState('');
  const [regPwd, setRegPwd] = useState('');
  const [regPwd2, setRegPwd2] = useState('');
  const [regBusy, setRegBusy] = useState(false);
  const [regError, setRegError] = useState('');
  const [registeredEmpno, setRegisteredEmpno] = useState('');
  const [registeredEmail, setRegisteredEmail] = useState('');

  // 工号/邮箱动态预览（2026-11-26）：输入姓名防抖拉取「将分配」值（服务端真实查重），
  // 生僻字/请求失败降级 null 占位；注册瞬间仍以服务端回执为准（并发同名窗口）
  const [empnoPreview, setEmpnoPreview] = useState<RegisterResult | null>(null);
  useEffect(() => {
    const name = regName.trim();
    if (!name) {
      setEmpnoPreview(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      apiEmpnoPreview(name)
        .then((r) => {
          if (alive) setEmpnoPreview(r);
        })
        .catch(() => {
          if (alive) setEmpnoPreview(null);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [regName]);

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
        .then(() => {
          // 新口令同步本地记忆（该账号勾过记住密码才存）——否则自动登录兜底拿旧口令必撞 1001
          const uid = user?.uid;
          const entry = uid ? remembered.find((x) => x.account === uid) : undefined;
          if (uid && entry?.rememberPwd) void authLoginPasswordSet(uid, newPwd).catch(() => undefined);
        })
        .catch((e) => setPwdError(e instanceof Error ? e.message : '改密失败，请重试'))
        .finally(() => setPwdBusy(false));
    };
    return (
      <div style={AUTH_PAGE_STYLE}>
        <Card style={{ width: 360, margin: 'auto' }}>
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
        <Card style={{ width: 360, margin: 'auto' }}>
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
        <Card style={{ width: 360, margin: 'auto' }}>
          <AuthBrand title="注册账号" sub="姓名 + 口令即可，工号将自动分配" />
          <Form layout="vertical">
            <Form.Item label="姓名">
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
            {/* 工号/邮箱预览入框（2026-11-26）：输入姓名即动态显示「将分配」的真实值
                （服务端查重递增），只读不可改；预览仅供参考——并发同名以注册回执为准 */}
            <Form.Item label="工号（自动生成，登录账号）">
              <Input value={empnoPreview?.employee_no ?? ''} placeholder="输入姓名后自动生成" disabled data-testid="register-empno-preview" />
            </Form.Item>
            <Form.Item label="邮箱（自动生成，不可修改）">
              <Input value={empnoPreview?.email ?? ''} placeholder="输入姓名后自动生成" disabled data-testid="register-email-preview" />
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
          form={form}
          layout="vertical"
          disabled={locked}
          onFinish={(values) => {
            // 账号口径：选中组织用户用工号；否则直接采信输入文本（自动填充/手输均可登录）
            const acct = (picked?.employee_no ?? account).trim();
            if (!acct) {
              setPickError('请输入账号（工号 / 邮箱 / 手机号），或从历史账号中选择');
              return;
            }
            setPickError('');
            void login(acct, String(values.password ?? ''), { rememberPwd, autoLogin });
          }}
        >
          <Form.Item label="账号">
            <AccountPicker
              account={account}
              onAccountChange={setAccount}
              selected={picked}
              onSelect={setPicked}
              remembered={remembered}
              onPickRemembered={(a) => void pickRemembered(a)}
              onRemoveRemembered={removeRemembered}
              disabled={locked}
            />
            {pickError ? <Alert type="error" showIcon message={pickError} data-testid="login-pick-error" style={{ marginTop: 8 }} /> : null}
          </Form.Item>
          <Form.Item name="password" label="口令" rules={[{ required: true, message: '请输入口令' }]}>
            <Input.Password ref={passwordRef} placeholder="请输入口令" autoComplete="current-password" size="large" />
          </Form.Item>

          {/* QQ 式双开关：勾自动登录联动勾住记住密码；取消记住密码连带取消自动登录 */}
          <Flex justify="space-between" style={{ marginBottom: 12 }}>
            <Checkbox
              checked={rememberPwd}
              disabled={locked || autoLogin}
              onChange={(e) => {
                const v = e.target.checked;
                setRememberPwd(v);
                if (!v) setAutoLogin(false);
              }}
              data-testid="login-remember-pwd"
            >
              记住密码
            </Checkbox>
            <Checkbox
              checked={autoLogin}
              disabled={locked}
              onChange={(e) => {
                const v = e.target.checked;
                setAutoLogin(v);
                if (v) setRememberPwd(true);
              }}
              data-testid="login-auto-login"
            >
              自动登录
            </Checkbox>
          </Flex>

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
