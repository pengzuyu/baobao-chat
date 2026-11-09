/**
 * PAG-13/14/15 专家库页（D14 §4）：公司库/个人库双栏卡片 + 编辑器弹窗
 * （manifest YAML 发布，个人命名空间校验提示）+ 详情抽屉（manifest 预览/
 * 下架/删除）。PAG-16 协作图/PAG-17 摘要卡=Agent 会话产物视图，随
 * D17：「用此专家开会话」入口——建工作台会话（mode=ask + manifest model 直达引用；
 * persona/skills 注入随宿主 expert_id 参数阶段二，登记）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Building2, Download, Pencil, Plus, Sparkles, Trash2, User, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { StateView } from '../../../shared/ui/StateView';
import * as api from '../api/expert';
import type { EcoExpert } from '../model/types';
import { useNavigate } from 'react-router-dom';
import { useAgentStore } from '../../agent/store/agent';

const BLANK_MANIFEST = `id: usr.1001.my-expert
type: local
version: 1.0.0
display: 我的专家
persona: |
  你是……（角色与输出契约）
tools:
  builtin: [read_file, git_diff]
constraints:
  max_steps: 40
  write_policy: readonly
source: personal
`;

export function ExpertLibraryPage() {
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
      await useAgentStore.getState().startSession('ask', model);
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

  const card = (e: EcoExpert) => (
    <li key={e.id} className="exp-card" onClick={() => void openDetail(e)}>
      <div className="exp-card__head">
        <b>{e.display}</b>
        <code>v{e.version}</code>
      </div>
      <p>{e.summary}</p>
      <div className="exp-card__foot">
        <code className="exp-card__id">{e.expert_id}</code>
        {e.source === 2 && (
          <button
            className="exp-card__del"
            onClick={(ev) => {
              ev.stopPropagation();
              if (confirm(`下架「${e.display}」？（个人库可再发布）`)) {
                void api.unpublishExpert(e.id).then(() => setReloadKey((k) => k + 1));
              }
            }}
          >
            <Trash2 size={13} /> 下架
          </button>
        )}
      </div>
    </li>
  );

  return (
    <div className="exp-page">
      <header className="exp-page__bar">
        <span className="exp-page__title">
          <Sparkles size={16} /> 专家库
        </span>
        <Button variant="primary" onClick={() => setEditorOpen(true)}>
          <Plus size={14} /> 创建专家
        </Button>
      </header>

      <div className="exp-page__cols">
        <section className="exp-page__col">
          <h4>
            <Building2 size={14} /> 公司库（{company.length}）
          </h4>
          <StateView state={loading ? 'loading' : 'ok'} emptyText="公司库暂无发布">
            <ul className="exp-page__list">{company.map(card)}</ul>
          </StateView>
        </section>
        <section className="exp-page__col">
          <h4>
            <User size={14} /> 个人库（{mine.length}）
          </h4>
          <StateView state={loading ? 'loading' : 'ok'} emptyText="自建专家将显示在这里（usr.{你的uid}. 前缀）">
            <ul className="exp-page__list">{mine.map(card)}</ul>
          </StateView>
        </section>
      </div>

      {editorOpen && (
        <ExpertEditorModal
          onClose={() => setEditorOpen(false)}
          onPublished={() => setReloadKey((k) => k + 1)}
        />
      )}

      {detail && (
        <div className="exp-detail__mask" onClick={(e) => e.target === e.currentTarget && setDetail(null)}>
          <aside className="exp-detail">
            <div className="exp-detail__head">
              <div>
                <h3>{detail.display}</h3>
                <small>
                  {detail.expert_id} · v{detail.version} · {detail.source === 1 ? '公司库' : '个人库'}
                </small>
              </div>
              <button className="exp-detail__close" onClick={() => setDetail(null)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="exp-detail__body">
              <h4>定义包（manifest）</h4>
              <pre className="exp-detail__manifest">{detailManifest}</pre>
              <p className="exp-detail__tip">
                Agent Runtime 启动时经 BBW_RT_EXPERTS_URL 自动同步本库（D14 §5 分发）。
              </p>
              <button
                type="button"
                className="btn btn--primary exp-detail__start"
                data-testid="expert-start-session"
                onClick={() => void startExpertSession()}
              >
                用此专家开会话
              </button>
            </div>
          </aside>
        </div>
      )}
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
    <div className="exp-editor__mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="exp-editor">
        <div className="exp-editor__head">
          <span>
            <Pencil size={14} /> 创建专家（个人库）
          </span>
          <button onClick={onClose} aria-label="关闭" className="exp-detail__close">
            <X size={16} />
          </button>
        </div>
        <div className="exp-editor__body">
          <p className="exp-editor__tip">
            声明式 YAML（D14 §2）：id 须 <code>usr.你的uid.</code> 前缀；工具仅可引用运行时已注册清单；深校验由 Agent 侧解析兜底。
          </p>
          <textarea
            className="exp-editor__yaml"
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            spellCheck={false}
            rows={20}
          />
          {err && <p className="exp-editor__err">⚠ {err}</p>}
        </div>
        <div className="exp-editor__foot">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void publish()}>
            <Download size={13} /> 发布到个人库
          </Button>
        </div>
      </div>
    </div>
  );
}
