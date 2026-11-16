/**
 * 初始化向导页（16 篇 §2.2 Web 化主通道）：
 * 首次部署（系统无任何用户）时引导建立首个平台管理员——只填工号/姓名/口令
 * 三项，成功后自动登录进系统。已初始化系统不出现本页（status 1014 兜底跳回）。
 * D26-O3：login-page/login-card 自研壳退役——居中布局内联 + antd Card、错误条→Alert；向导逻辑不动。
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography } from 'antd';
import { Navigate, useNavigate } from 'react-router-dom';
import { apiSetupBootstrap, apiSetupStatus } from '../api/auth';
import { getErrorText } from '../../../shared/api/http';
import { Logo } from '../../../shared/ui/Logo';
import { APP_NAME, COPYRIGHT } from '../../../shared/brand';
import { useAuthStore } from '../store/auth';

type SetupPhase = 'checking' | 'uninitialized' | 'initialized';

const AUTH_PAGE_STYLE: CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };

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
    <div style={AUTH_PAGE_STYLE}>
      <Card style={{ width: 360 }}>
        <Flex vertical align="center" gap={4} style={{ textAlign: 'center', marginBottom: 20 }}>
          <Logo size={44} />
          <Typography.Title level={4} style={{ margin: '8px 0 0' }}>
            欢迎使用 {APP_NAME}
          </Typography.Title>
          <Typography.Text type="secondary">首次部署 · 创建平台管理员即完成初始化</Typography.Text>
        </Flex>

        {phase === 'checking' ? null : (
          <Form
            layout="vertical"
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

            {errorText ? <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} /> : null}

            <Button block size="large" htmlType="submit" loading={submitting}>
              完成初始化并进入
            </Button>
          </Form>
        )}

        <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', fontSize: 12, marginTop: 16 }}>
          创建后可登录管理台创建普通用户与部门
          <br />{COPYRIGHT}
        </Typography.Text>
      </Card>
    </div>
  );
}
