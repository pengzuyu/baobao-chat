/**
 * 澄清提问卡（D20 ask_user → clarify.request；ZCode AskUserQuestion 形态）：
 * - 问题 + 短标签 Tag + 选项按钮组（multiSelect 多选）+「其他」自由补充 + 提交
 * - 不超时：一直等用户回答；「停止」中断由会话侧收口 cancelled（终态灰显）
 * - 三端共用：工作台流内=本卡；聊天页 Modal / IM 落流卡内嵌条=复用 ClarifyForm
 * D26-O6：clarify-card/clarify-form/clarify-opt 类退役——内联 token + antd Tag/Input/
 * Typography（listbox 语义与多选行为原样保留）。
 */

import { memo, useMemo, useState } from 'react';
import { Input, Tag, Typography, theme } from 'antd';
import { HelpCircle } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import type { ClarifyOptionDTO } from '../bridge/types';
import type { StreamItem } from '../store/agent';

type ClarifyItem = Extract<StreamItem, { kind: 'clarify' }>;

export interface ClarifySubmit {
  answers: string[];
  freeText: string;
}

/** 选项作答表单（三端共用：单/多选 + 自由补充 + 提交；waiting 状态渲染） */
export const ClarifyForm = memo(function ClarifyForm({
  question,
  header,
  options,
  multiSelect,
  onSubmit,
}: {
  question: string;
  header?: string;
  options: ClarifyOptionDTO[];
  multiSelect: boolean;
  onSubmit: (s: ClarifySubmit) => void;
}) {
  const { token } = theme.useToken();
  const [picked, setPicked] = useState<string[]>([]);
  const [free, setFree] = useState('');
  const [expanded, setExpanded] = useState(false);

  const toggle = (label: string) => {
    setPicked((cur) =>
      multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? [label]
          : [label],
    );
  };
  const submit = () => {
    if (!picked.length && !free.trim()) return;
    onSubmit({ answers: picked, freeText: free.trim() });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        {header ? <Tag style={{ fontSize: 11, lineHeight: '18px', borderRadius: 999, marginInlineEnd: 0, flexShrink: 0 }}>{header}</Tag> : null}
        <Typography.Text strong style={{ fontSize: 13 }}>
          {question}
        </Typography.Text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} role="listbox" aria-multiselectable={multiSelect}>
        {options.map((o) => {
          const active = picked.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => toggle(o.label)}
              title={o.description}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                textAlign: 'left',
                cursor: 'pointer',
                padding: '7px 10px',
                borderRadius: token.borderRadius,
                border: `1px solid ${active ? token.colorPrimary : token.colorBorderSecondary}`,
                background: active ? token.colorPrimaryBg : 'transparent',
              }}
            >
              <Typography.Text style={{ fontSize: 13 }}>{o.label}</Typography.Text>
              {o.description ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {o.description}
                </Typography.Text>
              ) : null}
            </button>
          );
        })}
      </div>
      {expanded ? (
        <Input
          value={free}
          onChange={(e) => setFree(e.target.value)}
          placeholder="补充说明（可选）"
          aria-label="补充说明"
          style={{ fontSize: 13 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          }}
        />
      ) : (
        <Button variant="text" size="small" style={{ alignSelf: 'flex-start', padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setExpanded(true)}>
          其他 / 补充说明…
        </Button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button onClick={submit} disabled={!picked.length && !free.trim()}>
          提交回答
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {multiSelect ? '可多选' : '单选'}
          {picked.length ? ` · 已选 ${picked.length}` : ''}
        </Typography.Text>
      </div>
    </div>
  );
});

/** 工作台流内提问卡（终态折叠为「已回答：xxx」/「已中断」摘要行） */
export const ClarifyCard = memo(function ClarifyCard({
  item,
  onRespond,
}: {
  item: ClarifyItem;
  onRespond: (questionId: string, s: ClarifySubmit) => void;
}) {
  const { token } = theme.useToken();
  const waiting = item.answer === null;
  const settled = useMemo(() => {
    if (!item.answer) return null;
    if (item.answer.decision === 'cancelled') return { text: '已中断（提问未回答）', dim: true };
    return { text: `已回答：${item.answer.answers}`, dim: false };
  }, [item.answer]);

  return (
    <div
      data-question-id={item.request.questionId}
      style={{
        alignSelf: 'stretch',
        border: `1px solid ${waiting ? token.colorPrimary : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        overflow: 'hidden',
        opacity: waiting ? 1 : 0.85,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: token.colorPrimaryBg }}>
        <HelpCircle size={14} aria-hidden style={{ color: token.colorPrimary }} />
        <Typography.Text strong style={{ fontSize: 12 }}>
          Agent 提问
        </Typography.Text>
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {waiting ? (
          <ClarifyForm
            question={item.request.question}
            header={item.request.header}
            options={item.request.options}
            multiSelect={item.request.multiSelect}
            onSubmit={(s) => onRespond(item.request.questionId, s)}
          />
        ) : (
          <Typography.Text type={settled?.dim ? 'secondary' : undefined} style={{ fontSize: 12 }}>
            {settled?.text}
          </Typography.Text>
        )}
      </div>
    </div>
  );
});
