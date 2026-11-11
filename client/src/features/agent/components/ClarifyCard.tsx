/**
 * 澄清提问卡（D20 ask_user → clarify.request；ZCode AskUserQuestion 形态）：
 * - 问题 + 短标签 chip + 选项按钮组（multiSelect 多选）+「其他」自由补充 + 提交
 * - 不超时：一直等用户回答；「停止」中断由会话侧收口 cancelled（终态灰显）
 * - 三端共用：工作台流内=本卡；聊天页 Modal / IM 落流卡内嵌条=复用 ClarifyForm
 */

import { memo, useMemo, useState } from 'react';
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
    <div className="clarify-form">
      <div className="clarify-form__head">
        {header ? <span className="clarify-form__chip">{header}</span> : null}
        <span className="clarify-form__question">{question}</span>
      </div>
      <div className="clarify-form__options" role="listbox" aria-multiselectable={multiSelect}>
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            role="option"
            aria-selected={picked.includes(o.label)}
            className={`clarify-opt${picked.includes(o.label) ? ' clarify-opt--active' : ''}`}
            onClick={() => toggle(o.label)}
            title={o.description}
          >
            <span className="clarify-opt__label">{o.label}</span>
            {o.description ? <span className="clarify-opt__desc">{o.description}</span> : null}
          </button>
        ))}
      </div>
      {expanded ? (
        <input
          className="clarify-form__free"
          value={free}
          onChange={(e) => setFree(e.target.value)}
          placeholder="补充说明（可选）"
          aria-label="补充说明"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          }}
        />
      ) : (
        <button type="button" className="clarify-form__other" onClick={() => setExpanded(true)}>
          其他 / 补充说明…
        </button>
      )}
      <div className="clarify-form__actions">
        <Button variant="primary" onClick={submit} disabled={!picked.length && !free.trim()}>
          提交回答
        </Button>
        <span className="clarify-form__hint">{multiSelect ? '可多选' : '单选'}{picked.length ? ` · 已选 ${picked.length}` : ''}</span>
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
  const waiting = item.answer === null;
  const settled = useMemo(() => {
    if (!item.answer) return null;
    if (item.answer.decision === 'cancelled') return { text: '已中断（提问未回答）', dim: true };
    return { text: `已回答：${item.answer.answers}`, dim: false };
  }, [item.answer]);

  return (
    <div className={`clarify-card${waiting ? '' : ' clarify-card--settled'}`} data-question-id={item.request.questionId}>
      <div className="clarify-card__head">
        <HelpCircle size={14} className="clarify-card__icon" aria-hidden />
        <span className="clarify-card__title">Agent 提问</span>
      </div>
      <div className="clarify-card__body">
        {waiting ? (
          <ClarifyForm
            question={item.request.question}
            header={item.request.header}
            options={item.request.options}
            multiSelect={item.request.multiSelect}
            onSubmit={(s) => onRespond(item.request.questionId, s)}
          />
        ) : (
          <div className={`clarify-card__outcome${settled?.dim ? ' clarify-card__outcome--dim' : ''}`}>{settled?.text}</div>
        )}
      </div>
    </div>
  );
});
