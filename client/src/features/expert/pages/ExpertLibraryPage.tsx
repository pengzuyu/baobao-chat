/**
 * PAG-13/14/15 专家库页（D14 §4）：公司库/个人库双栏卡片 + 编辑器弹窗
 * （manifest YAML 发布，个人命名空间校验提示）+ 详情抽屉（manifest 预览/
 * 下架/删除）。
 * D17：「用此专家开会话」入口——建工作台会话（mode=工作台默认档 + manifest model 直达引用；
 * persona/skills 注入随宿主 expert_id 参数阶段二，登记）。
 * D26-O3：exp-* 自研壳退役——卡片→Card、编辑器→Modal+Form、详情→Drawer、
 * 下架 confirm→Modal.confirm（danger）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, Drawer, Flex, Form, Input, Modal, Space, theme, Typography } from 'antd';
import { Building2, Download, Plus, Sparkles, Trash2, User } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { StateView } from '../../../shared/ui/StateView';
import * as api from '../api/expert';
import type { EcoExpert } from '../model/types';
import { useNavigate } from 'react-router-dom';
import { useAgentStore } from '../../agent/store/agent';
import { DEFAULT_PERMISSION_MODE } from '../../agent/bridge/types';

const BLANK_MANIFEST = `id: usr.1001.my-expert
type: local
version: 1.0.0
display: 我的专家
persona: |
  你是……（角色与输出契约）
tools:
  builtin: [read_file, glob_files, grep_files]
constraints:
  max_steps: 40
  write_policy: readonly
source: personal
`;

export function ExpertLibraryPage() {
  const { token } = theme.useToken();
  const [rows, setRows] = useState<EcoExpert[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [detail, setDetail] = useState<EcoExpert | null>(null);
  const [detailManifest, setDetailManifest] = useState('');
  const navigate = useNavigate();
  /** D17：建工作台会话并跳转（model 取 manifest 直达引用行；persona 注入随 expert_id 阶段二） */
  const [starting, setStarting] = useState(false);
  const startExpertSession = async () => {
    if (starting || !detail) return;
    setStarting(true);
    try {
      // manifest 的 model: 行 → 直达引用原样透传（如 p:3:glm-4.7 或档位别名）
      const manifest = await api.downloadManifest(detail.id).catch(() => '');
      const modelLine = manifest.split('\n').find((l) => /^\s*model:\s*\S+/.test(l));
      const model = modelLine ? modelLine.replace(/^\s*model:\s*/, '').trim() : undefined;
      await useAgentStore.getState().startSession(DEFAULT_PERMISSION_MODE, model);
      const sid = useAgentStore.getState().activeSessionId;
      if (sid) navigate(`/agent/s/${sid}`);
    } finally {
      setStarting(false);
    }
  };
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.listExperts('all'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const company = (rows ?? []).filter((e) => e.source === 1);
  const mine = (rows ?? []).filter((e) => e.source === 2);

  const openDetail = async (e: EcoExpert) => {
    setDetail(e);
    setDetailManifest('加载中…');
    setDetailManifest(await api.downloadManifest(e.id));
  };

  const confirmUnpublish = (e: EcoExpert) => {
    Modal.confirm({
      title: `下架「${e.display}」？（个人库可再发布）`,
      okText: '下架',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => api.unpublishExpert(e.id).then(() => setReloadKey((k) => k + 1)),
    });
  };

  const card = (e: EcoExpert) => (
    <Card key={e.id} size="small" hoverable onClick={() => void openDetail(e)}>
      <Flex align="center" justify="space-between" gap={8}>
        <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
          {e.display}
        </Typography.Text>
        <Typography.Text code>v{e.version}</Typography.Text>
      </Flex>
      <Typography.Paragraph type="secondary" style={{ margin: '6px 0', fontSize: 12, lineHeight: 1.5 }}>
        {e.summary}
      </Typography.Paragraph>
      <Flex align="center" justify="space-between" gap={8}>
        <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
          {e.expert_id}
        </Typography.Text>
        {e.source === 2 && (
          <Button
            variant="danger"
            size="small"
            onClick={(ev) => {
              ev.stopPropagation();
              confirmUnpublish(e);
            }}
          >
            <Trash2 size={12} /> 下架
          </Button>
        )}
      </Flex>
    </Card>
  );

  const column = (title: React.ReactNode, emptyText: string, data: EcoExpert[]) => (
    <Card
      size="small"
      title={title}
      styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto' } }}
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <StateView state={loading ? 'loading' : 'ok'} emptyText={emptyText}>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {data.map(card)}
        </Space>
      </StateView>
    </Card>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Flex align="center" gap={8} style={{ padding: '12px 16px 0' }}>
        <Sparkles size={16} />
        <Typography.Title level={5} style={{ margin: 0 }}>
          专家库
        </Typography.Title>
        <span style={{ flex: 1 }} />
        <Button onClick={() => setEditorOpen(true)}>
          <Plus size={14} /> 创建专家
        </Button>
      </Flex>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 16, minHeight: 0, overflow: 'hidden' }}>
        {column(
          <Space size={4}>
            <Building2 size={14} /> 公司库（{company.length}）
          </Space>,
          '公司库暂无发布',
          company,
        )}
        {column(
          <Space size={4}>
            <User size={14} /> 个人库（{mine.length}）
          </Space>,
          '自建专家将显示在这里（usr.{你的uid}. 前缀）',
          mine,
        )}
      </div>

      {editorOpen && (
        <ExpertEditorModal
          onClose={() => setEditorOpen(false)}
          onPublished={() => setReloadKey((k) => k + 1)}
        />
      )}

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={520}
        destroyOnClose
        title={detail?.display ?? ''}
        extra={
          detail ? (
            <Typography.Text type="secondary">
              {detail.expert_id} · v{detail.version} · {detail.source === 1 ? '公司库' : '个人库'}
            </Typography.Text>
          ) : null
        }
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="secondary" onClick={() => setDetail(null)}>
              关闭
            </Button>
            <Button loading={starting} onClick={() => void startExpertSession()} data-testid="expert-start-session">
              用此专家开会话
            </Button>
          </div>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text strong>定义包（manifest）</Typography.Text>
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: token.colorFillQuaternary,
              borderRadius: 6,
            }}
          >
            {detailManifest}
          </pre>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Agent Runtime 启动时经 BBC_RT_EXPERTS_URL 自动同步本库（D14 §5 分发）。
          </Typography.Text>
        </Space>
      </Drawer>
    </div>
  );
}

/** PAG-15 编辑器（表单化 v0.1=YAML 直编 + 模板起点 + 发布） */
function ExpertEditorModal({ onClose, onPublished }: { onClose: () => void; onPublished: () => void }) {
  const [manifest, setManifest] = useState(BLANK_MANIFEST);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.publishExpert(manifest);
      onPublished();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '发布失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="创建专家（个人库）"
      width={640}
      onCancel={onClose}
      destroyOnClose
      footer={[
        <Button key="cancel" variant="secondary" onClick={onClose}>
          取消
        </Button>,
        <Button key="ok" loading={busy} onClick={() => void publish()}>
          <Download size={13} /> 发布到个人库
        </Button>,
      ]}
    >
      <Form layout="vertical">
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          声明式 YAML（D14 §2）：id 须 <Typography.Text code>usr.你的uid.</Typography.Text> 前缀；工具仅可引用运行时已注册清单；深校验由 Agent 侧解析兜底。
        </Typography.Paragraph>
        <Form.Item label="manifest YAML">
          <Input.TextArea
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            autoSize={{ minRows: 18, maxRows: 26 }}
            spellCheck={false}
          />
        </Form.Item>
        {err ? <Alert type="error" showIcon message={err} /> : null}
      </Form>
    </Modal>
  );
}
