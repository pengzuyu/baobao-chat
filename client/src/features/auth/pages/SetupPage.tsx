/**
 * 初始化向导页（16 篇 §2.2 Web 化主通道）：
 * 首次部署（系统无任何用户）时引导建立首个平台管理员——只填工号/姓名/口令
 * 三项，成功后自动登录进系统。已初始化系统不出现本页（status 1014 兜底跳回）。
 */

import { useEffect, useState } from 'react';
import { Button, Form, Input } from 'antd';
import { Navigate, useNavigate } from 'react-router-dom';
import { apiSetupBootstrap, apiSetupStatus } from '../api/auth';
import { getErrorText } from '../../../shared/api/http';
import { Logo } from '../../../shared/ui/Logo';
import { useAuthStore } from '../store/auth';

type SetupPhase = 'checking' | 'uninitialized' | 'initialized';

export function SetupPage() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const login = useAuthStore((s) => s.login);
  const [phase, setPhase] = useState<SetupPhase>('checking');
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // 状态探测：已初始化（或探测失败按已初始化处理，防误导向导）→ 回登录页
  useEffect(() => {
    let alive = true;
    apiSetupStatus()
      .then((s) => alive && setPhase(s.initialized ? 'initialized' : 'uninitialized'))
      .catch(() => alive && setPhase('initialized'));
    return () => {
      alive = false;
    };
  }, []);

  if (token) return <Navigate to="/im" replace />;
  if (phase === 'initialized') return <Navigate to="/auth" replace />;

  const onFinish = async (values: { employeeNo: string; displayName: string; password: string }) => {
    setSubmitting(true);
    setErrorText(null);
    try {
      await apiSetupBootstrap(values.employeeNo, values.displayName, values.password);
      // 建户即关向导；口令仍在内存——直接走登录链路进系统
      await login(values.employeeNo, values.password);
      navigate('/im', { replace: true });
    } catch (err) {
      const code = (err as { code?: number }).code ?? 9004;
      setErrorText(code === 1014 ? '系统已初始化，请直接登录' : getErrorText(code));
      if (code === 1014) setPhase('initialized');
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__brand">
          <Logo size={44} />
          <div className="login-card__title">欢迎使用 BaobaoWork</div>
          <div className="login-card__sub">首次部署 · 创建平台管理员即完成初始化</div>
        </div>

        {phase === 'checking' ? null : (
          <Form
            layout="vertical"
            className="login-card__form"
            onFinish={(values) => void onFinish(values as { employeeNo: string; displayName: string; password: string })}
            disabled={submitting}
            initialValues={{ employeeNo: 'admin', displayName: '平台管理员' }}
          >
            <Form.Item name="employeeNo" label="管理员工号" rules={[{ required: true, message: '请输入工号' }, { max: 64, message: '≤64 字' }]}>
              <Input placeholder="登录用工号，缺省 admin" autoComplete="username" size="large" />
            </Form.Item>
            <Form.Item name="displayName" label="姓名" rules={[{ required: true, message: '请输入姓名' }, { max: 64, message: '≤64 字' }]}>
              <Input placeholder="对外展示姓名" size="large" />
            </Form.Item>
            <Form.Item name="password" label="管理员口令" rules={[{ required: true, message: '请输入口令' }, { min: 8, message: '至少 8 位' }]}>
              <Input.Password placeholder="至少 8 位" autoComplete="new-password" size="large" />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="确认口令"
              dependencies={['password']}
              rules={[
                { required: true, message: '请再次输入口令' },
                ({ getFieldValue }) => ({
                  validator: (_, v: string) =>
                    !v || v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次口令不一致')),
                }),
              ]}
            >
              <Input.Password placeholder="再次输入口令" autoComplete="new-password" size="large" />
            </Form.Item>

            {errorText ? <div className="login-card__error">{errorText}</div> : null}

            <Button block size="large" htmlType="submit" loading={submitting} className="login-card__submit">
              完成初始化并进入
            </Button>
          </Form>
        )}

        <div className="login-card__footer">
          创建后可登录管理台创建普通用户与部门
          <br />© 2026 BaobaoWork
        </div>
      </div>
    </div>
  );
}
