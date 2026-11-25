/**
 * OIDC desktop 授权确认卡（D28 批2/Q2b，§5.1）：
 * 深链 bbc://auth 拉起 → 应用名/scope/6 位码展示 → 用户核对与浏览器页面一致后
 * 点自己头像确认。grant 已覆盖 → 轻量形态（免码即点）。未登录 → 引导先登录。
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Avatar, Modal, Space, Tag, Typography, message } from 'antd';
import { useAuthStore } from '../store/auth';
import { apiOidcConfirm, apiOidcConfirmInfo, type OidcConfirmInfo } from '../api/oidc';
import { scopeLabel } from '../scopeLabels';
import { ApiError } from '../../../shared/api/http';
import { APP_NAME } from '../../../shared/brand';

type Phase = 'loading' | 'need-login' | 'ready' | 'done' | 'error';

export function OidcConfirmCard({ reqId, onClose }: { reqId: string; onClose: () => void }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<OidcConfirmInfo | null>(null);
  const [errText, setErrText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [leftSec, setLeftSec] = useState(0);

  const load = useCallback(async () => {
    if (!token) {
      setPhase('need-login');
      return;
    }
    try {
      const d = await apiOidcConfirmInfo(reqId);
      setInfo(d);
      setLeftSec(d.expires_in_sec);
      setPhase('ready');
    } catch (e) {
      setPhase('error');
      setErrText(e instanceof ApiError ? e.message : '确认请求获取失败');
    }
  }, [reqId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  // 登录态出现时自动重载（深链先到、登录后到的场景）
  useEffect(() => {
    if (phase === 'need-login' && token) void load();
  }, [phase, token, load]);

  // 倒计时（0 即过期口径由服务端 1010 兜底）
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = setInterval(() => setLeftSec((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const approve = async () => {
    if (!info || submitting) return;
    setSubmitting(true);
    try {
      await apiOidcConfirm(reqId, info.covered_by_grant ? '' : info.code);
      setPhase('done');
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 1012) {
          const left = (e.details as { attempts_left?: number } | undefined)?.attempts_left;
          void message.error(left ? `确认码不匹配，剩余 ${left} 次机会` : '确认码错误次数过多，请求已作废');
          if (left === undefined) {
            setPhase('error');
            setErrText('确认码错误次数过多，请求已作废——请回到浏览器重新发起登录');
          }
        } else if (e.code === 1010) {
          setPhase('error');
          setErrText('确认请求已过期——请回到浏览器重新发起登录');
        } else {
          void message.error(e.message || '确认失败');
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="应用授权确认"
      onCancel={onClose}
      footer={null}
      width={380}
      destroyOnHidden
    >
      {phase === 'loading' && <Typography.Text type="secondary">正在获取确认信息…</Typography.Text>}

      {phase === 'need-login' && (
        <Alert
          type="warning"
          showIcon
          message={`请先登录 ${APP_NAME}`}
          description="在应用内登录后回到本卡片，会自动继续确认流程。"
        />
      )}

      {phase === 'error' && (
        <Alert type="error" showIcon message="无法完成确认" description={errText} />
      )}

      {phase === 'done' && (
        <Alert type="success" showIcon message="已确认授权" description="请回到浏览器继续，页面将自动跳转。" />
      )}

      {phase === 'ready' && info && (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              以下应用请求以你的身份访问
            </Typography.Text>
            <Typography.Title level={5} style={{ margin: '4px 0 0' }}>
              {info.app_name}
            </Typography.Title>
          </div>
          <Space size={[6, 6]} wrap>
            {info.scopes.map((s) => (
              <Tag key={s}>{scopeLabel(s)}</Tag>
            ))}
          </Space>

          {info.covered_by_grant ? (
            <Alert type="info" showIcon message="你此前已授权过该应用，点头像即可完成本次登录。" />
          ) : (
            <div style={{ textAlign: 'center', border: '1px dashed var(--bbc-gray-3)', borderRadius: 8, padding: '10px 0' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                确认码（与浏览器页面核对一致后再确认）
              </Typography.Text>
              <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 8, fontVariantNumeric: 'tabular-nums' }}>
                {info.code}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <Avatar
              size={44}
              style={{ backgroundColor: 'var(--bbc-primary)', cursor: submitting ? 'wait' : 'pointer', flexShrink: 0 }}
              onClick={() => void approve()}
            >
              {(user?.name ?? '?').slice(0, 1)}
            </Avatar>
            <div>
              <Typography.Text strong>{user?.name}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {submitting ? '正在确认…' : '点击头像确认授权'}
                {leftSec > 0 ? ` · ${Math.floor(leftSec / 60)}:${String(leftSec % 60).padStart(2, '0')} 后失效` : ''}
              </Typography.Text>
            </div>
          </div>
        </Space>
      )}
    </Modal>
  );
}
