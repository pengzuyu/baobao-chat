/**
 * 管理后台 · 客户端发布（D39）：管理员上传安装包并发布，客户端自动更新与官网下载区
 * 由服务端动态清单驱动（/update/latest.json、/update/release-info.json）。
 *
 * 流程：选包（左安装包 / 右 .sig 双拖拽区，桌面端整窗拖入按类型自动分配）→
 *      版本号从包内 Info.plist 自动识别回填 → 直传对象存储（预签名，不经服务端）→
 *      登记草稿（点击上传时统一读 sig 文件；服务端强制 minisign 验签+包内版本一致性
 *      校验）→ 列表行内「发布」→ 出问题行内「回滚/撤回」（清单指针语义）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload/interface';
import { InboxOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { gunzip } from 'fflate';
import { pathsToFiles } from '../../../shared/attachments';
import { useFileDrop } from '../../../shared/attachments/hooks';
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

/**
 * 平台期望产物口径（0.1.7）：每平台的「应用内自更新」与「官网直链」两通道各自必需的
 * 产物形态——更新包（tar.gz/AppImage/exe+签名）updater 专用；直链包（dmg/exe/deb）官网
 * 首装下载。Windows 的 setup.exe 两用（updater passive 静默安装+官网直链同一文件）。
 * 列表按版本×平台聚合展示齐备度，发布确认时列出缺口（缺口不阻断发布——补传后可再发布）。
 */
const PLATFORM_EXPECT: Record<string, { updater: RegExp; direct: RegExp; updaterLabel: string; directLabel: string }> = {
  'darwin-aarch64': { updater: /\.app\.tar\.gz$/i, direct: /\.dmg$/i, updaterLabel: '更新包 .app.tar.gz(+.sig)', directLabel: '官网直链 .dmg' },
  'darwin-x86_64': { updater: /\.app\.tar\.gz$/i, direct: /\.dmg$/i, updaterLabel: '更新包 .app.tar.gz(+.sig)', directLabel: '官网直链 .dmg' },
  'windows-x86_64': { updater: /-setup\.exe$/i, direct: /-setup\.exe$/i, updaterLabel: '更新包 -setup.exe(+.sig)', directLabel: 'setup.exe（两用）' },
  'linux-x86_64': { updater: /\.AppImage$/i, direct: /\.deb$/i, updaterLabel: '更新包 .AppImage(+.sig)', directLabel: '官网直链 .deb' },
};

/** 版本×平台聚合齐备度：missing 为空=更新包（含签名）+直链包齐备 */
function platformCompleteness(items: ClientRelease[], version: string, platform: string): { missing: string[] } {
  const exp = PLATFORM_EXPECT[platform];
  if (!exp) return { missing: [] };
  const rows = items.filter((i) => i.version === version && i.platform === platform && i.status !== 'revoked');
  const missing: string[] = [];
  const updater = rows.find((r) => exp.updater.test(r.filename));
  if (!updater) missing.push(exp.updaterLabel);
  else if (!updater.has_signature) missing.push('更新包签名');
  if (!rows.some((r) => exp.direct.test(r.filename))) missing.push(exp.directLabel);
  return { missing };
}

/** 该版本全部已知平台的缺口清单（发布确认用；未登记任何产物的平台不算缺口） */
function versionGaps(items: ClientRelease[], version: string): string[] {
  const out: string[] = [];
  const platforms = new Set(items.filter((i) => i.version === version && i.status !== 'revoked').map((i) => i.platform));
  platforms.forEach((p) => {
    const { missing } = platformCompleteness(items, version, p);
    if (missing.length > 0) {
      out.push(`${PLATFORMS.find((x) => x.value === p)?.label ?? p} 缺 ${missing.join('、')}`);
    }
  });
  return out;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * 列表按「版本×平台」聚合（0.1.7 用户拍板：一个版本一行，tar.gz+sig+dmg 放一起管理）。
 * 存储仍是行粒度制品（唯一约束/发布 SQL 均按制品行），聚合只在展示层。
 * 组状态聚合：任一 published→published（组内另有 draft=「补传中」）；全 revoked→revoked；余 draft。
 */
interface GroupedRow {
  key: string;
  version: string;
  platform: string;
  updater?: ClientRelease; // 更新包行（tar.gz/AppImage/exe）
  direct?: ClientRelease; // 官网直链行（dmg/deb；Windows 无独立直链行）
  rows: ClientRelease[];
  status: ClientRelease['status'] | 'mixed';
  createdAt: string;
}

function groupByRelease(items: ClientRelease[]): GroupedRow[] {
  const groups = new Map<string, GroupedRow>();
  for (const r of items) {
    const key = `${r.version}|${r.platform}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, version: r.version, platform: r.platform, rows: [], status: 'draft', createdAt: r.created_at };
      groups.set(key, g);
    }
    g.rows.push(r);
    if (r.created_at < g.createdAt) g.createdAt = r.created_at;
    const exp = PLATFORM_EXPECT[r.platform];
    if (exp?.updater.test(r.filename)) g.updater = r;
    if (exp?.direct.test(r.filename) && !exp.updater.test(r.filename)) g.direct = r;
  }
  const out = Array.from(groups.values());
  for (const g of out) {
    g.rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const st = new Set(g.rows.map((r) => r.status));
    if (st.has('published')) g.status = st.has('draft') ? 'mixed' : 'published';
    else if (st.size === 1 && st.has('revoked')) g.status = 'revoked';
    else g.status = 'draft';
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const GROUP_TAG: Record<string, { color: string; text: string }> = {
  draft: { color: 'default', text: '草稿' },
  published: { color: 'green', text: '已发布' },
  revoked: { color: 'red', text: '已撤回' },
  mixed: { color: 'orange', text: '补传中' },
};

interface UploadForm {
  version: string;
  platform: string;
  notes?: string;
}

/**
 * 从 .app.tar.gz 中识别版本号（读 Info.plist 的 CFBundleShortVersionString）。
 * fflate 异步解压不卡 UI；tar 512B 头手写遍历（只找 Info.plist 一个 entry，够用）。
 * 非 .app.tar.gz / 解析失败 → null（保持手填；服务端 register 只对 tar.gz 强校验）。
 */
async function detectPkgVersion(file: File): Promise<string | null> {
  if (!/\.app\.tar\.gz$/i.test(file.name)) return null;
  try {
    const gz = new Uint8Array(await file.arrayBuffer());
    const tar = await new Promise<Uint8Array>((resolve, reject) =>
      gunzip(gz, (err, data) => (err ? reject(err) : resolve(data))),
    );
    const dec = new TextDecoder();
    let off = 0;
    while (off + 512 <= tar.length) {
      const name = dec.decode(tar.subarray(off, off + 100)).replace(/\0[\s\S]*$/, '');
      if (!name) break; // 结束块
      const size = parseInt(dec.decode(tar.subarray(off + 124, off + 136)).replace(/\0[\s\S]*$/, '').trim(), 8) || 0;
      const dataStart = off + 512;
      if (/\.app\/Contents\/Info\.plist$/.test(name)) {
        const xml = dec.decode(tar.subarray(dataStart, dataStart + size));
        const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
        return m ? m[1] : null;
      }
      off = dataStart + Math.ceil(size / 512) * 512;
    }
    return null;
  } catch {
    return null;
  }
}

export function ClientReleasePage() {
  const [channel, setChannel] = useState('stable');
  const [data, setData] = useState<ReleaseList>({ items: [], live_version: '' });
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pkgFile, setPkgFile] = useState<File | null>(null);
  const [sigFile, setSigFile] = useState<File | null>(null);
  const [directFile, setDirectFile] = useState<File | null>(null);
  const [form] = Form.useForm<UploadForm>();
  const platform = Form.useWatch('platform', form);
  const exp = PLATFORM_EXPECT[platform] ?? undefined;
  // Windows setup.exe 两用（更新包与官网直链同一文件）：无需独立直链槽
  const dualUse = !!exp && exp.updater.source === exp.direct.source;

  // 切平台清空三槽（旧平台文件对新平台口径不再合法）
  useEffect(() => {
    setPkgFile(null);
    setSigFile(null);
    setDirectFile(null);
  }, [platform]);
  const [opBusy, setOpBusy] = useState<string>('');

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

  const resetUpload = () => {
    setUploadOpen(false);
    setPkgFile(null);
    setSigFile(null);
    setDirectFile(null);
    form.resetFields();
  };

  /** 选文件分流（点击任一区 / 整窗拖入共用：按后缀/内容自动识别归属） */
  const pickFiles = async (files: File[]) => {
    for (const f of files) {
      let head = '';
      if (f.size < 4096) {
        try {
          head = await f.slice(0, 17).text();
        } catch {
          /* 忽略读头失败 */
        }
      }
      if (/\.sig$/i.test(f.name) || head.startsWith('untrusted comment:')) {
        setSigFile(f);
        void message.info(`已选择签名文件 ${f.name}`);
      } else if (exp && exp.direct.test(f.name) && !exp.updater.test(f.name)) {
        // 官网直链槽（dmg/deb；exe 两用归更新包槽）
        setDirectFile(f);
        void message.info(`已选择官网直链包 ${f.name}`);
      } else {
        setPkgFile(f);
        const ver = await detectPkgVersion(f);
        if (ver) {
          form.setFieldValue('version', ver);
          void message.info(`已识别版本号 v${ver}（${f.name}）`);
        }
      }
    }
  };

  /** 官网直链槽定向接收：平台口径校验，放错文件当场拒绝 */
  const acceptDirect = (f: File) => {
    const e = PLATFORM_EXPECT[platform];
    if (e && !e.direct.test(f.name)) {
      void message.error(`直链槽只收 ${e.directLabel.split('（')[0]}，收到的是 ${f.name}`);
      return;
    }
    setDirectFile(f);
  };

  // 桌面端整窗拖拽（弹窗打开期间生效）：拖入路径读回 File 再分流；
  // dragOver 只作两区高亮，归属由分流逻辑决定，无需区分落点
  const dragOver = useFileDrop(uploadOpen, (paths) => {
    void pathsToFiles(paths)
      .then((files) => pickFiles(files))
      .catch((e) => void message.error(String(e instanceof Error ? e.message : e)));
  });

  const doUpload = async () => {
    const v = await form.validateFields();
    if (!pkgFile) {
      void message.error('请选择安装包文件');
      return;
    }
    // sig 内容统一在上传时才读取（选区只存 File 引用，不展示内容）
    const sigText = sigFile ? (await sigFile.text()).trim() : '';
    const needSig = /\.app\.tar\.gz$|\.AppImage$|-setup\.exe$/.test(pkgFile.name);
    if (needSig && !sigText) {
      void message.error('自动更新包必须配 .sig 签名文件（在右侧选择或拖入）');
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
      // 3. 本地算 sha256 + 登记草稿（服务端将强制验签+包内版本一致性校验）
      const sha = await sha256Hex(pkgFile);
      await apiReleaseRegister({
        version: v.version,
        channel,
        platform: v.platform,
        filename: pkgFile.name,
        size: pkgFile.size,
        sha256: sha,
        storage_key: pre.storage_key,
        signature: sigText,
        notes: v.notes ?? '',
      });
      // 第二轮：官网直链包（可选；文件名与更新包不同→独立 storage key 不撞唯一约束）
      if (directFile) {
        const pre2 = await apiReleasePresign({
          version: v.version,
          channel,
          platform: v.platform,
          filename: directFile.name,
        });
        await putFileDirect(pre2.upload_url, directFile);
        const sha2 = await sha256Hex(directFile);
        await apiReleaseRegister({
          version: v.version,
          channel,
          platform: v.platform,
          filename: directFile.name,
          size: directFile.size,
          sha256: sha2,
          storage_key: pre2.storage_key,
          signature: '', // 直链包不经 updater，无签名需求
          notes: v.notes ?? '',
        });
      }
      void message.success(
        directFile
          ? `已上传 ${v.version} / ${v.platform}（更新包+官网直链，草稿，在列表行内点「发布」生效）`
          : `已上传 ${v.version} / ${v.platform}（仅更新包，官网直链包可随时补传，草稿，行内点「发布」生效）`,
      );
      resetUpload();
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setSubmitting(false);
    }
  };

  const doPublish = async (version: string) => {
    setOpBusy(`publish:${version}`);
    try {
      const r = await apiReleasePublish(version, channel);
      void message.success(`已发布 ${version}（${r.published} 个平台包）`);
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setOpBusy('');
    }
  };

  const doRevoke = async (version: string) => {
    setOpBusy(`revoke:${version}`);
    try {
      const r = await apiReleaseRevoke(version, channel);
      void message.success(`已撤回 ${version}（${r.revoked} 个平台包，已装用户不受影响）`);
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setOpBusy('');
    }
  };

  const doRollback = async (version: string) => {
    setOpBusy(`rollback:${version}`);
    try {
      await apiReleaseRollback(version, channel);
      void message.success(`已回滚：线上版本 → ${version}`);
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setOpBusy('');
    }
  };

  const doDelete = async (ids: number[]) => {
    try {
      await Promise.all(ids.map((id) => apiReleaseDelete(id)));
      void message.success(`已删除 ${ids.length} 条登记记录（制品文件保留在对象存储）`);
      await load(channel);
    } catch (e) {
      void message.error(String(e instanceof Error ? e.message : e));
    }
  };

  const columns: ColumnsType<GroupedRow> = [
    {
      title: '版本',
      dataIndex: 'version',
      width: 96,
      render: (v: string, g) => (
        <Space size={4}>
          <Typography.Text strong>v{v}</Typography.Text>
          {g.status === 'published' && v === data.live_version ? <Tag color="blue">线上</Tag> : null}
        </Space>
      ),
    },
    {
      title: '平台',
      dataIndex: 'platform',
      width: 190,
      render: (p: string, g) => {
        const label = PLATFORMS.find((x) => x.value === p)?.label ?? p;
        if (!PLATFORM_EXPECT[p]) return label;
        const { missing } = platformCompleteness(data.items, g.version, p);
        return (
          <Space size={4}>
            <span>{label}</span>
            {missing.length === 0 ? (
              <Tag color="green">齐</Tag>
            ) : (
              <Tooltip title={`缺：${missing.join('、')}（同版本追加登记补传后再次发布即可）`}>
                <Tag color="orange">缺 {missing.length} 项</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: '产物（更新包+官网直链）',
      render: (_, g) => (
        <Space direction="vertical" size={2}>
          {g.updater && (
            <Typography.Text style={{ fontSize: 12 }}>
              <Tag color="processing" style={{ marginRight: 4 }}>更新</Tag>
              {g.updater.filename} · {fmtSize(g.updater.size)}
              {g.updater.has_signature ? ' · 已签名' : ' · 未签名'}
            </Typography.Text>
          )}
          {g.direct && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <Tag style={{ marginRight: 4 }}>直链</Tag>
              {g.direct.filename} · {fmtSize(g.direct.size)}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (st: GroupedRow['status']) => (
        <Space size={4}>
          <Tag color={GROUP_TAG[st].color}>{GROUP_TAG[st].text}</Tag>
          {st === 'mixed' && (
            <Tooltip title="组内既有已发布又有新补传草稿——再点一次「发布」即可让补传生效">
              <Tag color="orange">发布后生效</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '上传时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      width: 168,
      render: (_, g) => {
        if (g.status === 'draft' || g.status === 'mixed') {
          return (
            <Space size={4}>
              <Popconfirm
                title={`发布 v${g.version}？`}
                description={(() => {
                  const gaps = versionGaps(data.items, g.version);
                  return gaps.length > 0
                    ? `进入分发（客户端可升级）。产物缺口：${gaps.join('；')}——可发布后补传再发布`
                    : '各平台更新包与官网直链包齐备，进入分发（客户端可升级）';
                })()}
                okText="发布"
                onConfirm={() => void doPublish(g.version)}
              >
                <Button size="small" type="primary" ghost loading={opBusy === `publish:${g.version}`}>
                  发布
                </Button>
              </Popconfirm>
              <Popconfirm
                title="删除该平台全部登记记录？"
                description="仅删除登记记录（制品文件保留在对象存储）；同版本可重新上传"
                okText="删除"
                okButtonProps={{ danger: true }}
                onConfirm={() => void doDelete(g.rows.map((r) => r.id))}
              >
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          );
        }
        if (g.status === 'revoked') {
          return (
            <Space size={4}>
              <Popconfirm
                title={`重新发布 v${g.version}？`}
                description="重新进入分发且立即成为线上版本（客户端下次检查即升级）"
                okText="重新发布"
                onConfirm={() => void doPublish(g.version)}
              >
                <Button size="small" type="primary" ghost loading={opBusy === `publish:${g.version}`}>
                  重新发布
                </Button>
              </Popconfirm>
              <Popconfirm
                title="删除该平台全部登记记录？"
                description="仅删除登记记录（制品文件保留在对象存储）；同版本可重新上传"
                okText="删除"
                okButtonProps={{ danger: true }}
                onConfirm={() => void doDelete(g.rows.map((r) => r.id))}
              >
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          );
        }
        const isLive = g.version === data.live_version;
        return (
          <Space size={4}>
            {!isLive && (
              <Popconfirm
                title={`回滚到 v${g.version}？`}
                description="线上清单指针切回该版本（不挪文件；客户端下次检查即回到该版本）"
                okText="回滚"
                onConfirm={() => void doRollback(g.version)}
              >
                <Button size="small" loading={opBusy === `rollback:${g.version}`}>
                  回滚
                </Button>
              </Popconfirm>
            )}
            <Popconfirm
              title={`撤回 v${g.version}？`}
              description="从分发移除（已安装用户不受影响）"
              okText="撤回"
              okButtonProps={{ danger: true }}
              onConfirm={() => void doRevoke(g.version)}
            >
              <Button size="small" danger loading={opBusy === `revoke:${g.version}`}>
                撤回
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];
  const grouped = useMemo(() => groupByRelease(data.items), [data.items]);

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
        title="线上版本"
        extra={
          <Button type="primary" onClick={() => setUploadOpen(true)}>
            上传安装包
          </Button>
        }
      >
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="当前线上">
            {data.live_version ? (
              <Tag color="blue">v{data.live_version}</Tag>
            ) : (
              <Typography.Text type="secondary">尚未发布（客户端将回落静态清单）</Typography.Text>
            )}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Alert
        type="info"
        showIcon
        message="发布前请确认："
        description={
          <span>
            ① 上传弹窗按平台分槽位：更新包（应用内自更新，必配 .sig）+ 官网直链包（官网下载，可选），版本号自动识别；
            ② 列表按版本×平台聚合，一行管全部产物；发布/回滚/撤回在行内操作；
            ③ 登记时服务端强制校验签名与包内版本；④ 发布后内容不可改，只能撤回或发新版本。
          </span>
        }
      />

      <Table
        rowKey="key"
        size="small"
        loading={loading}
        dataSource={grouped}
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
          <Form.Item name="version" label="版本号" extra="选择更新包后自动从包内识别，可手动修正" rules={[{ required: true, message: '如 0.1.7' }]}>
            <Input placeholder="0.1.7" />
          </Form.Item>
          <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
            {/* 弹窗内下拉挂到表单项上（2026-11-23 Windows 真机）：默认挂 body，
                弹层坐标与层级都跨出弹窗上下文，真机上出现过「点了弹不出来」；
                挂进弹窗内部后跟随弹窗层级与滚动，5 个固定选项也不会被裁 */}
            <Select options={PLATFORMS} getPopupContainer={(trigger) => trigger.parentElement ?? document.body} />
          </Form.Item>
          <Form.Item label="更新包（应用内自更新必需）" required extra={exp ? `收 ${exp.updaterLabel.split('（')[0]}，选后自动识别版本号` : undefined}>
            <Row gutter={12}>
              <Col span={12} style={dragOver ? { outline: '2px dashed #1677ff', outlineOffset: 2, borderRadius: 8 } : undefined}>
                <Upload.Dragger
                  multiple
                  beforeUpload={(f) => {
                    void pickFiles([f]);
                    return false; // 不自动上传：由提交流程走预签名直传
                  }}
                  onRemove={() => {
                    setPkgFile(null);
                    return false;
                  }}
                  showUploadList={{ showPreviewIcon: false }}
                  fileList={pkgFile ? ([{ uid: '-pkg', name: pkgFile.name, status: 'done' } as UploadFile]) : []}
                >
                  <p className="ant-upload-drag-icon">
                    <InboxOutlined />
                  </p>
                  <p className="ant-upload-text">更新包{dragOver ? '：松手自动填入' : ''}</p>
                  <p className="ant-upload-hint">{exp ? exp.updaterLabel.split('（')[0] : '.app.tar.gz / .AppImage / -setup.exe'}</p>
                </Upload.Dragger>
              </Col>
              <Col span={12} style={dragOver ? { outline: '2px dashed #1677ff', outlineOffset: 2, borderRadius: 8 } : undefined}>
                <Upload.Dragger
                  accept=".sig"
                  beforeUpload={(f) => {
                    void pickFiles([f]);
                    return false;
                  }}
                  onRemove={() => {
                    setSigFile(null);
                    return false;
                  }}
                  showUploadList={{ showPreviewIcon: false }}
                  fileList={sigFile ? ([{ uid: '-sig', name: sigFile.name, status: 'done' } as UploadFile]) : []}
                >
                  <p className="ant-upload-drag-icon">
                    <SafetyCertificateOutlined />
                  </p>
                  <p className="ant-upload-text">签名文件（.sig）{dragOver ? '：松手自动填入' : ''}</p>
                  <p className="ant-upload-hint">更新包必配；{exp ? exp.directLabel.split('（')[0] : '直链包'}免签</p>
                </Upload.Dragger>
              </Col>
            </Row>
          </Form.Item>
          {dualUse ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              该平台 setup.exe 官网直链与应用内更新为同一文件，无需单独直链包。
            </Typography.Text>
          ) : (
            <Form.Item
              label="官网直链包（可选——缺了官网无法下载，可随时补传）"
              extra={exp ? `收 ${exp.directLabel.split('（')[0]}` : undefined}
            >
              <Upload
                maxCount={1}
                beforeUpload={(f) => {
                  acceptDirect(f);
                  return false;
                }}
                onRemove={() => {
                  setDirectFile(null);
                  return false;
                }}
                showUploadList={{ showPreviewIcon: false }}
                fileList={directFile ? ([{ uid: '-direct', name: directFile.name, status: 'done' } as UploadFile]) : []}
              >
                <Button icon={<InboxOutlined />}>选择{exp ? exp.directLabel.split('（')[0] : '直链包'}</Button>
              </Upload>
            </Form.Item>
          )}
          <Form.Item name="notes" label="更新说明（可选）">
            <Input.TextArea rows={2} placeholder="本次更新要点，展示在官网与客户端更新提示" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
