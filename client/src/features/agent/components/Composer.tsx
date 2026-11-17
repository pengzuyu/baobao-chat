/**
 * 工作台输入区（PAG-03 §3.3 输入框规范）：
 * - Enter 发送 / Shift+Enter 换行
 * - 暂停/等待审批/运行中/已结束等态禁用（禁用规则见 store.composerDisabledFor）
 * - 停止按钮为红色（2026-11-11：中断当前轮=收口 idle 可继续，取代旧「紧急停止」
 *   杀进程语义——杀进程兜底退居 ⌘⇧. 全局快捷键）
 * - 斜杠命令（D22 §2/L5）：`/` 开头弹插件命令下拉（↑↓ 导航/Enter 选中/Esc 关）；
 *   发送时 `/name args` 命中→模板渲染（$ARGUMENTS=全部参数、$1..$9=位置参数）
 *   作为用户消息发进会话；未命中原样发送
 * D26-O4：textarea→Input.TextArea(autoSize)、壳类 agent-composer* 退役（内联布局）；
 * 自动聚焦/快捷键/IME 防误发/禁言态行为原样保留。
 */

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Flex, Input, Typography, theme } from 'antd';
import { Send, Square } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useImeGuard } from '../../../shared/hooks/useImeGuard';
import { renderCommand, type PluginCommand } from '../../eco/api/plugins';

interface ComposerProps {
  disabled: boolean;
  disabledHint?: string;
  /** 运行/等待审批/子任务/委派中展示红色停止（中断当前轮） */
  canStop: boolean;
  onSend: (text: string) => void;
  /** 停止当前会话正在生成的回答（interrupt；会话保留可继续追问） */
  onStop: () => void;
  /** 权限模式选择（2026-11-11 挪入输入框：页面注入 Dropdown 节点） */
  modePicker?: ReactNode;
  /** 模型+思考强度选择（2026-11-11 zcode 同款合体 Popover：页面注入 ModelThinkPicker） */
  modelPicker?: ReactNode;
  /** 插件斜杠命令表（D22/L5；空表=功能关闭零成本） */
  commands?: PluginCommand[];
}

export function Composer({ disabled, disabledHint, canStop, onSend, onStop, modePicker, modelPicker, commands = [] }: ComposerProps) {
  const { token } = theme.useToken();
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { imeEnterDecision, imeCompositionProps } = useImeGuard();
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);

  // `/` 开头 → 候选命令（首词前缀过滤；含空格后不再过滤——用户已在输参数）
  const slashCandidates = useMemo<PluginCommand[]>(() => {
    if (!slashOpen || commands.length === 0 || !text.startsWith('/')) return [];
    const firstToken = text.split(/\s/, 1)[0] ?? '';
    const q = firstToken.slice(1).toLowerCase();
    return commands.filter((c) => (q === '' ? true : c.name.toLowerCase().startsWith(q))).slice(0, 6);
  }, [slashOpen, text, commands]);

  const applyCommand = (cmd: PluginCommand) => {
    setText(`/${cmd.name} `);
    setSlashOpen(false);
    taRef.current?.focus();
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    // 斜杠命令解析：/name args... 命中→模板渲染；未命中原样（普通消息）
    let outgoing = trimmed;
    if (trimmed.startsWith('/')) {
      const [head, ...args] = trimmed.split(/\s+/);
      const cmd = commands.find((c) => c.name === head.slice(1));
      if (cmd) outgoing = renderCommand(cmd, args);
    }
    onSend(outgoing);
    setText('');
    setSlashOpen(false);
    taRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 下拉导航：↑↓/Enter 选命令、Esc 关闭（下拉激活时优先于发送）
    if (slashCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % slashCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + slashCandidates.length) % slashCandidates.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applyCommand(slashCandidates[slashIdx] ?? slashCandidates[0]);
        return;
      }
    }
    // IME 三态（useImeGuard v3）：ime=组合中交给输入法；swallow=确认键余波，吞掉不换行
    if (e.key === 'Enter' && !e.shiftKey) {
      const d = imeEnterDecision(e.nativeEvent);
      if (d === 'swallow') {
        e.preventDefault();
        return;
      }
      if (d !== 'send') return;
      // `/name` 严格相等（无参数无尾空格）且在候选中 → Enter=选中进参数态；
      // `/name `（带尾空格）或已输参数 → 正常发送渲染后的模板
      const exact = commands.find((c) => text === `/${c.name}`);
      if (exact && slashCandidates.some((c) => c.name === exact.name)) {
        e.preventDefault();
        applyCommand(exact);
        return;
      }
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        padding: '8px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: token.colorBgContainer,
      }}
    >
      {slashCandidates.length > 0 ? (
        <div
          role="listbox"
          aria-label="插件命令"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: 4,
            marginBottom: 6,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
            background: token.colorBgContainer,
            boxShadow: token.boxShadowSecondary,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {slashCandidates.map((c, i) => (
            <button
              key={`${c.pluginId}/${c.name}`}
              type="button"
              role="option"
              aria-selected={i === slashIdx}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px',
                border: 'none',
                borderRadius: 6,
                background: i === slashIdx ? token.controlItemBgHover : 'transparent',
                cursor: 'pointer',
                fontSize: 12,
                textAlign: 'left',
                color: 'inherit',
                font: 'inherit',
              }}
              onMouseEnter={() => setSlashIdx(i)}
              onClick={() => applyCommand(c)}
            >
              <b>/{c.name}</b>
              {c.description ? (
                <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
                  {c.description}
                </Typography.Text>
              ) : <span style={{ flex: 1 }} />}
              <Typography.Text code style={{ fontSize: 11 }}>
                {c.pluginId}
              </Typography.Text>
            </button>
          ))}
        </div>
      ) : null}
      <Input.TextArea
        ref={taRef}
        value={text}
        autoSize={{ minRows: 2, maxRows: 8 }}
        placeholder={disabled ? (disabledHint ?? '当前状态不可输入') : '输入任务，Enter 发送（Shift+Enter 换行）；/ 唤起插件命令'}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          setSlashOpen(e.target.value.startsWith('/'));
          setSlashIdx(0);
        }}
        onKeyDown={onKeyDown}
        {...imeCompositionProps}
        aria-label="Agent 会话输入框"
      />
      <Flex justify="space-between" align="center" gap={8} wrap>
        {modePicker}
        {/* 模型 chip 紧挨操作区（2026-11-12 用户口径：靠近发送按钮） */}
        <Flex align="center" gap={8}>
          {modelPicker}
          <Flex gap={8}>
            {/* 停止（红色）：中断当前回答，会话保留可继续 */}
            {canStop ? (
              <Button variant="danger" onClick={onStop}>
                <Square size={12} aria-hidden />
                停止
              </Button>
            ) : null}
            <Button onClick={submit} disabled={disabled || !text.trim()}>
              <Send size={12} aria-hidden />
              发送
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </div>
  );
}
