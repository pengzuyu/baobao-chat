/**
 * 设置 · 个人资料（2026-11-17 个人签名模块）：
 * - 账号信息只读（姓名/工号/所属组织——显示名仍管理面/注册口径，不可自助改）
 * - 个人签名自助编辑：trim 后 ≤100 字、可清空（服务端同口径校验）；
 *   展示位仅单聊会话侧栏对端名片（ConvInfoSidebar），通讯录不展示——用户拍板；
 *   他人被动刷新感知（无 WS 广播）：保存后 invalidate 通讯录缓存即时拉新
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Descriptions, Flex, Input, Space, Typography } from 'antd';
import { fetchAllDirectoryUsers } from '../../contacts/api/contacts';
import { apiUpdateMyProfile } from '../../auth/api/auth';
import { useAuthStore } from '../../auth/store/auth';
import { Avatar as UserAvatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';

export function ProfileSettingsPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setSignature = useAuthStore((s) => s.setSignature);

  // 账号信息走通讯录缓存（与单聊名片同源 ['org','users','all']；含工号/组织链路）
  const usersQuery = useQuery({ queryKey: ['org', 'users', 'all'], queryFn: fetchAllDirectoryUsers });
  const me = user ? usersQuery.data?.find((u) => u.uid === user.uid) : undefined;

  // 草稿制：draft=null 跟随服务端真值，编辑后本地暂存直至保存/放弃
  const current = me?.signature ?? user?.signature ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const dirty = draft !== null && draft !== current;
  const [saved, setSaved] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (sig: string) => apiUpdateMyProfile(sig),
    onSuccess: (sig) => {
      setSignature(sig); // auth store 同步（编辑初值/多端一致兜底）
      setDraft(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['org', 'users'] });
    },
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>
        个人资料
      </Typography.Title>

      <Card size="small" title="账号信息">
        <Flex align="center" gap={16} wrap="wrap">
          <UserAvatar name={user?.name || '?'} size={56} />
          <div style={{ minWidth: 260, flex: 1, maxWidth: 480 }}>
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'name', label: '姓名', children: me?.display_name ?? user?.name ?? '-' },
                {
                  key: 'empno',
                  label: '工号',
                  children: <Typography.Text code>{me?.employee_no ?? '-'}</Typography.Text>,
                },
                { key: 'org', label: '所属组织', children: me?.org_path || '未分组' },
              ]}
            />
          </div>
        </Flex>
      </Card>

      <Card size="small" title="个人签名">
        <Flex vertical gap={8}>
          <Input
            value={value}
            maxLength={100}
            showCount
            placeholder="写一句签名，展示在单聊会话名片上（留空即清除）"
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
            }}
            style={{ maxWidth: 480 }}
            data-testid="profile-signature-input"
          />
          <Space size={8} wrap align="center">
            <Button
              size="small"
              loading={saveMutation.isPending}
              disabled={!dirty}
              onClick={() => saveMutation.mutate(value)}
              data-testid="profile-signature-save"
            >
              保存
            </Button>
            {saved && !dirty ? <Typography.Text type="success">已保存</Typography.Text> : null}
            {saveMutation.isError ? (
              <Typography.Text type="danger" data-testid="profile-signature-error">
                保存失败：{saveMutation.error instanceof Error ? saveMutation.error.message : '未知错误'}
              </Typography.Text>
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最长 100 字；展示位仅单聊会话详情名片，对方打开时自动刷新
            </Typography.Text>
          </Space>
        </Flex>
      </Card>
    </Space>
  );
}
