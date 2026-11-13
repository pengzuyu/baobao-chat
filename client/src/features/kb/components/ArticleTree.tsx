/**
 * 文章树（D26-O1 换装 antd Tree）：知识库左栏——两维度根（公司知识库/我的文章）
 * → 专栏目录递归嵌套（fetchNodes 懒加载 loadData）→ 文章叶子（点击开 tab）。
 * 目录节点 hover「+」新建子目录（titleRender 内联输入，唯一写入动作——文章本体无写入 UI 拍板）。
 * 子树存 childrenMap（parentKey→children），treeData 由 spaces+map 派生——新建后追加即现。
 */

import { memo, useState } from 'react';
import type { DataNode } from 'antd/es/tree';
import { useQueryClient } from '@tanstack/react-query';
import { Button as AntdButton, Input, Tree, Typography } from 'antd';
import { FileText, FolderPlus } from 'lucide-react';
import { createDir, fetchNodes } from '../api/kb';
import { useSpaces } from '../api/hooks';
import { SkeletonList } from '../../../shared/ui/Skeleton';

interface KNode extends DataNode {
  key: string;
  kind: 'space' | 'dir' | 'doc';
  spaceId: string;
  name: string;
  docId?: string;
  selectable?: boolean;
}

/** 内联建目录目标（树内 hover「+」） */
interface Adding {
  parentKey: string; // 'sp:{id}' 或 'd:{id}'
  spaceId: string;
  parentId: string; // '' = 维度根
}

function ArticleTreeInner(props: { onOpenDoc: (docId: string, title: string) => void }) {
  const spaces = useSpaces('all');
  const qc = useQueryClient();
  const [childrenMap, setChildrenMap] = useState<Record<string, KNode[]>>({});
  // null=未初始化（roots 加载后默认全展开）；[] = 用户已全部收起（不再回弹）
  const [expandedKeys, setExpandedKeys] = useState<string[] | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [addingName, setAddingName] = useState('');
  const [addingErr, setAddingErr] = useState('');

  if (spaces.isError) {
    return <div className="kb-tree__error">维度加载失败，请重试</div>;
  }
  if (spaces.isPending) {
    return <SkeletonList count={5} />;
  }

  // 两维度根：公司在前（公共分享主场），我的文章在后
  const ordered = [...(spaces.data ?? [])].sort((a, b) => (a.space_type === 'company' ? -1 : b.space_type === 'company' ? 1 : 0));

  /** treeData：根由 spaces 派生，子层查 childrenMap（undefined=未加载→可展开触发 loadData） */
  const withChildren = (node: KNode): KNode => {
    const children = childrenMap[node.key];
    return children ? { ...node, children: children.map(withChildren) } : node;
  };
  const treeData: KNode[] = ordered.map((sp) =>
    withChildren({
      key: `sp:${sp.id}`,
      kind: 'space',
      spaceId: sp.id,
      name: sp.space_type === 'personal' ? '我的文章' : sp.name,
      selectable: false,
    }),
  );
  // 根默认展开（首访即见两维度内容）；用户手动收过后以手动态为准
  const rootKeys = ordered.map((sp) => `sp:${sp.id}`);
  const expanded = expandedKeys ?? rootKeys;

  /** 懒加载：展开未加载节点 → fetchNodes → childrenMap */
  const loadData = async (node: DataNode) => {
    const n = node as KNode;
    if (n.kind === 'doc' || childrenMap[n.key]) return;
    const parentId = n.kind === 'space' ? '' : n.key.slice(3);
    try {
      const { dirs = [], docs = [] } = await fetchNodes(n.spaceId, parentId || undefined);
      setChildrenMap((m) => ({
        ...m,
        [n.key]: [
          ...dirs.map<KNode>((d) => ({
            key: `d:${d.id}`,
            kind: 'dir',
            spaceId: n.spaceId,
            name: d.name,
            selectable: false,
          })),
          ...docs.map<KNode>((doc) => ({
            key: `doc:${doc.id}`,
            kind: 'doc',
            spaceId: n.spaceId,
            name: doc.title,
            docId: doc.id,
            isLeaf: true,
            selectable: true,
          })),
        ],
      }));
    } catch {
      /* 展开失败：antd 不标记 loaded，收起再展开可重试 */
    }
  };

  /** 内联建目录提交（7014 同名 → 内联提示） */
  const submitAdd = async (target: Adding) => {
    const name = addingName.trim();
    if (!name) return;
    setAddingErr('');
    try {
      const created = await createDir(target.spaceId, name, target.parentId || undefined);
      void qc.invalidateQueries({ queryKey: ['kb', 'nodes'] });
      setChildrenMap((m) => ({
        ...m,
        [target.parentKey]: [
          ...(m[target.parentKey] ?? []),
          { key: `d:${created.id}`, kind: 'dir', spaceId: target.spaceId, name: created.name, selectable: false },
        ],
      }));
      setAdding(null);
      setAddingName('');
      setExpandedKeys((ks) => {
        const cur = ks ?? [];
        return cur.includes(target.parentKey) ? cur : [...cur, target.parentKey];
      });
    } catch (e) {
      setAddingErr(e instanceof Error && e.message.includes('7014') ? '同名目录' : '创建失败');
    }
  };

  /** titleRender：space=名称+计数；dir=名称+hover「+」/内联表单；doc=图标+标题 */
  const titleRender = (node: DataNode) => {
    const n = node as KNode;
    if (n.kind === 'space') {
      const sp = ordered.find((s) => `sp:${s.id}` === n.key);
      return (
        <span data-testid="kb-tree-root">
          {n.name} <Typography.Text type="secondary">{sp?.doc_count}</Typography.Text>
        </span>
      );
    }
    if (n.kind === 'dir') {
      const target: Adding = { parentKey: n.key, spaceId: n.spaceId, parentId: n.key.slice(3) };
      return adding?.parentKey === n.key ? (
        <span className="kb-tree__add-form" onClick={(e) => e.stopPropagation()}>
          <Input
            size="small"
            placeholder="目录名"
            value={addingName}
            autoFocus
            style={{ width: 140 }}
            onChange={(e) => setAddingName(e.target.value)}
            onPressEnter={() => void submitAdd(target)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAdding(null);
            }}
          />
          <AntdButton size="small" type="primary" disabled={!addingName.trim()} onClick={() => void submitAdd(target)}>
            建
          </AntdButton>
          {addingErr ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {addingErr}
            </Typography.Text>
          ) : null}
        </span>
      ) : (
        <span data-testid="kb-tree-dir">
          {n.name}
          <AntdButton
            className="kb-tree__add"
            type="text"
            size="small"
            icon={<FolderPlus size={12} />}
            title="新建子目录"
            onClick={(e) => {
              e.stopPropagation();
              setAdding(target);
              setAddingName('');
              setAddingErr('');
            }}
          />
        </span>
      );
    }
    return (
      <span data-testid="kb-tree-doc" className="kb-tree__doc-title">
        <FileText size={13} className="kb-tree__doc-icon" />
        {n.name}
      </span>
    );
  };

  return (
    <div className="kb-tree" data-testid="kb-tree">
      <Tree
        blockNode
        treeData={treeData}
        titleRender={titleRender}
        expandedKeys={expanded}
        onExpand={(keys) => setExpandedKeys(keys.map(String))}
        loadData={loadData}
        onSelect={(_keys, info) => {
          const n = info.node as KNode;
          if (n.kind === 'doc' && n.docId) props.onOpenDoc(n.docId, n.name);
        }}
      />
    </div>
  );
}

/** memo：tab 切换/弹窗开合时左树整棵跳过重渲染（onOpenDoc 由 KbShell useCallback 稳定化） */
export const ArticleTree = memo(ArticleTreeInner);
