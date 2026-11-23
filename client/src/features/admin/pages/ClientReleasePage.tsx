/**
 * 管理后台 · 客户端发布（D39）：管理员上传安装包并发布，客户端自动更新与官网下载区
 * 由服务端动态清单驱动（/update/latest.json、/update/release-info.json）。
 *
 * 流程：选包 → 直传对象存储（预签名，不经服务端）→ 登记草稿（自动算 sha256 + 读 .sig）
 *      → 同版本平台齐后「发布」→ 出问题「回滚」到历史版本（清单指针语义，不挪文件）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload/interface';
import { InboxOutlined } from '@ant-design/icons';
import {
  apiReleaseDelete,
  apiReleaseList,
  apiReleasePresign,
  apiReleasePublish,
  apiReleaseRegister,
  apiReleaseRevoke,
  apiReleaseRollback,
  putFileDirect,
  sha256Hex,
  type ClientRelease,
  type ReleaseList,
} from '../api/clientRelease';

const PLATFORMS = [
  { value: 'darwin-aarch64', label: 'macOS（Apple 芯片）' },
  { value: 'darwin-x86_64', label: 'macOS（Intel 芯片）' },
  { value: 'linux-x86_64', label: 'Linux（AppImage）' },
  { value: 'windows-x86_64', label: 'Windows（NSIS）' },
];

const STATUS_TAG: Record<ClientRelease['status'], { color: string; text: string }> = {
  draft: { color: 'default', text: '草稿' },
  published: { color: 'green', text: '已发布' },
  revoked: { color: 'red', text: '已撤回' },
};

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

interface UploadForm {
  version: string;
  platform: string;
  notes?: string;
}

export function ClientReleasePage() {
  const [channel, setChannel] = useState('stable');
  const [data, setData] = useState<ReleaseList>({ items: [], live_version: '' });
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pkgFile, setPkgFile] = useState<File | null>(null);
  const [sigText, setSigText] = useState('');
  const [form] = Form.useForm<UploadForm>();
  const [opVersion, setOpVersion] = useState<string>();
  const [opBusy, setOpBusy] = useState(false);

  const load = useCallback(async (ch: string) => {
    setLoading(true);
    try {
      setData(await apiReleaseList(ch));
    } catch {
      /* 信封错误全局兜底 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(channel);
  }, [channel, load]);

  const versions = useMemo(() => {
    const set = new Set(data.items.map((i) => i.version));
    return Array.from(set).sort((a, b) => compareVer(b, a));
  }, [data.items]);

  const resetUpload = () => {
    setUploadOpen(false);
    setPkgFile(null);
    setSigText('');
    form.resetFields();
  };

  const doUpload = async () => {
    const v = await form.validateFields();
    if (!pkgFile) {
      void message.error('请选择安装包文件');
      return;
    }
    const needSig = /\.app\.tar\.gz$|\.AppImage$|-setup\.exe$/.test(pkgFile.name);
    if (needSig && !sigText.trim()) {
      void message.error('自动更新包必须同时上传 .sig 签名文件（.sig 的内容）');
      return;
    }
    setSubmitting(true);
    try {
      // 1. 取直传票据
      const pre = await apiReleasePresign({
        version: v.version,
        channel,
        platform: v.platform,
        filename: pkgFile.name,
      });
      // 2. 直传对象存储（不经服务端）
      await putFileDirect(pre.upload_url, pkgFile);
      // 3. 本地算 sha256 + 登记草稿
      const sha = await sha256Hex(pkgFile);
      await apiReleaseRegister({
        version: v.version,
        channel,
        platform: v.platform,
        filename: pkgFile.name,
        size: pkgFile.size,
        sha256: sha,
        storage_key: pre.storage_key,
        signature: sigText.trim(),
        notes: v.notes ?? '',
      });
      void message.success(`已上传 ${v.version} / ${v.platform}（草稿，需发布）`);
      resetUpload();
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setSubmitting(false);
    }
  };

  const doPublish = async () => {
    if (!opVersion) return void message.warning('请选择版本');
    setOpBusy(true);
    try {
      const r = await apiReleasePublish(opVersion, channel);
      void message.success(`已发布 ${opVersion}（${r.published} 个平台包）`);
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setOpBusy(false);
    }
  };

  const doRevoke = async () => {
    if (!opVersion) return void message.warning('请选择版本');
    setOpBusy(true);
    try {
      const r = await apiReleaseRevoke(opVersion, channel);
      void message.success(`已撤回 ${opVersion}（${r.revoked} 个平台包，已装用户不受影响）`);
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setOpBusy(false);
    }
  };

  const doRollback = async () => {
    if (!opVersion) return void message.warning('请选择版本');
    setOpBusy(true);
    try {
      await apiReleaseRollback(opVersion, channel);
      void message.success(`已回滚：线上版本 → ${opVersion}`);
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setOpBusy(false);
    }
  };

  const doDelete = async (id: number) => {
    try {
      await apiReleaseDelete(id);
      void message.success('草稿已删除');
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    }
  };

  const columns: ColumnsType<ClientRelease> = [
    {
      title: '版本',
      dataIndex: 'version',
      width: 92,
      render: (v: string, r) => (
        <Space size={4}>
          <Typography.Text strong>v{v}</Typography.Text>
          {r.status === 'published' && v === data.live_version ? <Tag color="blue">线上</Tag> : null}
        </Space>
      ),
    },
    { title: '平台', dataIndex: 'platform', width: 150, render: (p: string) => PLATFORMS.find((x) => x.value === p)?.label ?? p },
    { title: '文件', dataIndex: 'filename', ellipsis: true },
    { title: '大小', dataIndex: 'size', width: 90, render: (n: number) => fmtSize(n) },
    {
      title: '签名',
      dataIndex: 'has_signature',
      width: 76,
      render: (has: boolean) => (has ? <Tag color="green">有</Tag> : <Tag>无</Tag>),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: ClientRelease['status']) => <Tag color={STATUS_TAG[s].color}>{STATUS_TAG[s].text}</Tag>,
    },
    {
      title: '上传时间',
      dataIndex: 'created_at',
      width: 160,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      width: 90,
      render: (_, r) =>
        r.status === 'draft' ? (
          <Popconfirm title="删除该草稿？" okText="删除" cancelText="取消" onConfirm={() => void doDelete(r.id)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Tabs
        activeKey={channel}
        onChange={setChannel}
        items={[
          { key: 'stable', label: '稳定通道' },
          { key: 'beta', label: '内测通道（beta）' },
        ]}
      />

      <Card
        size="small"
        title="线上版本与操作"
        extra={
          <Button type="primary" onClick={() => setUploadOpen(true)}>
            上传安装包
          </Button>
        }
      >
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="当前线上">
            {data.live_version ? (
              <Tag color="blue">v{data.live_version}</Tag>
            ) : (
              <Typography.Text type="secondary">尚未发布（客户端将回落静态清单）</Typography.Text>
            )}
          </Descriptions.Item>
        </Descriptions>
        <Space wrap>
          <Select
            style={{ width: 200 }}
            placeholder="选择版本"
            value={opVersion}
            onChange={setOpVersion}
            options={versions.map((v) => ({ value: v, label: `v${v}` }))}
          />
          <Popconfirm title={`发布 ${opVersion ?? ''}？`} description="该版本全部草稿将进入分发（客户端可升级）" okText="发布" onConfirm={() => void doPublish()}>
            <Button loading={opBusy} type="primary" ghost>
              发布
            </Button>
          </Popconfirm>
          <Popconfirm title={`回滚到 ${opVersion ?? ''}？`} description="线上清单指针切回该版本（不挪文件；客户端下次检查即回到该版本）" okText="回滚" onConfirm={() => void doRollback()}>
            <Button loading={opBusy}>回滚到该版本</Button>
          </Popconfirm>
          <Popconfirm title={`撤回 ${opVersion ?? ''}？`} description="从分发移除（已安装用户不受影响）" okText="撤回" okButtonProps={{ danger: true }} onConfirm={() => void doRevoke()}>
            <Button loading={opBusy} danger>
              撤回
            </Button>
          </Popconfirm>
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        message="发布前请确认："
        description={
          <span>
            ① 产物已在 mac 侧用 minisign 签名（.app.tar.gz / .AppImage / setup.exe 必须有 .sig）；
            ② 同版本各平台包全部上传后再点「发布」；③ 发布后内容不可改，只能撤回或发新版本。
          </span>
        }
      />

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={data.items}
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
      />

      <Modal
        title="上传安装包"
        open={uploadOpen}
        onCancel={resetUpload}
        onOk={() => void doUpload()}
        confirmLoading={submitting}
        okText="上传并登记"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={{ platform: 'darwin-aarch64' }}>
          <Form.Item name="version" label="版本号" rules={[{ required: true, message: '如 0.2.0' }]}>
            <Input placeholder="0.2.0（与产物文件名中的版本一致）" />
          </Form.Item>
          <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
            {/* 弹窗内下拉挂到表单项上（2026-11-23 Windows 真机）：默认挂 body，
                弹层坐标与层级都跨出弹窗上下文，真机上出现过「点了弹不出来」；
                挂进弹窗内部后跟随弹窗层级与滚动，5 个固定选项也不会被裁 */}
            <Select options={PLATFORMS} getPopupContainer={(trigger) => trigger.parentElement ?? document.body} />
          </Form.Item>
          <Form.Item label="安装包文件" required>
            <Upload.Dragger
              maxCount={1}
              beforeUpload={(f) => {
                setPkgFile(f);
                return false; // 不自动上传：由提交流程走预签名直传
              }}
              onRemove={() => setPkgFile(null)}
              fileList={pkgFile ? ([{ uid: '-pkg', name: pkgFile.name, status: 'done' } as UploadFile]) : []}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽安装包到此处</p>
              <p className="ant-upload-hint">.dmg / .deb / .app.tar.gz / .AppImage / -setup.exe</p>
            </Upload.Dragger>
          </Form.Item>
          <Form.Item label="签名文件（.sig 内容）" extra="自动更新包必填：打开 .sig 文件，把内容粘贴到这里">
            <Input.TextArea rows={3} value={sigText} onChange={(e) => setSigText(e.target.value)} placeholder="untrusted comment: ..." />
          </Form.Item>
          <Form.Item name="notes" label="更新说明（可选）">
            <Input.TextArea rows={2} placeholder="本次更新要点，展示在官网与客户端更新提示" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 版本比较（数字段；非数字段按 0） */
function compareVer(a: string, b: string): number {
  const as = a.split('.').map((x) => parseInt(x, 10) || 0);
  const bs = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}