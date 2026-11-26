/**
 * 工作台输入区（PAG-03 §3.3 输入框规范）：
 * - Enter 发送 / Shift+Enter 换行
 * - 暂停/等待审批/运行中/已结束等态禁用（禁用规则见 store.composerDisabledFor）
 * - 停止按钮为红色（2026-11-11：中断当前轮=收口 idle 可继续，取代旧「紧急停止」
 *   杀进程语义——杀进程兜底退居 ⌘⇧. 全局快捷键）
 * - 斜杠命令（D22 §2/L5）：`/` 开头弹插件命令下拉（↑↓ 导航/Enter 选中/Esc 关）；
 *   发送时 `/name args` 命中→模板渲染（$ARGUMENTS=全部参数、$1..$9=位置参数）
 *   作为用户消息发进会话；未命中原样发送
 * - centered（2026-11-23 懒创建）：居中浮卡形态——新建会话页/空会话无聊天历史时
 *   输入框居中（zcode 同款）；缺省=底部横条。onSend 可回 Promise<boolean>，
 *   resolve false=未发出（如建会话失败）→ 还原输入原文
 * D26-O4：textarea→Input.TextArea(autoSize)、壳类 agent-composer* 退役（内联布局）；
 * 自动聚焦/快捷键/IME 防误发/禁言态行为原样保留。
 * 附件（2026-11-26）：📎 选择/拖拽/粘贴 → 待发区 chip（AttachmentStrip）→ 随消息发送；
 * 发送条件=文字或附件至少一项；失败（onSend resolve false/抛错）还原文字与附件。
 */

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Flex, Input, Typography, message as antdMessage, theme } from 'antd';
import { Paperclip, Send, Square } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useImeGuard } from '../../../shared/hooks/useImeGuard';
import { renderCommand, type PluginCommand } from '../../eco/api/plugins';
import {
  MAX_ATTACHMENTS,
  pickAttachmentPaths,
  savePastedImage,
  statAttachments,
} from '../../../shared/attachments';
import { AttachmentStrip, type StripItem } from '../../../shared/attachments/components';
import { useFileDrop, useImagePaste } from '../../../shared/attachments/hooks';
import type { AttachmentPayload } from '../bridge/types';

interface ComposerProps {
  disabled: boolean;
  disabledHint?: string;
  /** 居中浮卡形态（2026-11-23 新建会话页/空会话）：无聊天历史时输入框居中展示
   *  （zcode 同款）——去顶部横线改圆角描边+投影；缺省=底部横条原样 */
  centered?: boolean;
  /** 挂载即聚焦输入框（新建会话页；底部横条态保持不动焦） */
  autoFocus?: boolean;
  /** 运行/等待审批/子任务中展示红色停止（中断当前轮；唯一入口——
   *  2026-11-18 走查：工作台头部同款重复按钮退役） */
  canStop: boolean;
  /** 发送。可返回 Promise<boolean>：resolve false=未发出（如懒创建建会话失败）→
   *  还原输入原文与附件待发区供改写/重试；返回 void/true/其它=已发出，照常清空。
   *  attachments=待发附件（2026-11-26；仅附件无文字也发送） */
  onSend: (text: string, attachments: AttachmentPayload[]) => void | Promise<boolean | void>;
  /** 停止当前会话正在生成的回答（interrupt；会话保留可继续追问） */
  onStop: () => void;
  /** 权限模式选择（2026-11-11 挪入输入框：页面注入 Dropdown 节点） */
  modePicker?: ReactNode;
  /** 模型+思考强度选择（2026-11-11 zcode 同款合体 Popover：页面注入 ModelThinkPicker） */
  modelPicker?: ReactNode;
  /** 运行态状态条（D36：上下文消耗/占比/缓存命中；页面注入 ContextUsageMeter） */
  statusInfo?: ReactNode;
  /** 插件斜杠命令表（D22/L5；空表=功能关闭零成本） */
  commands?: PluginCommand[];
}

export function Composer({ disabled, disabledHint, centered = false, autoFocus = false, canStop, onSend, onStop, modePicker, modelPicker, statusInfo, commands = [] }: ComposerProps) {
  const { token } = theme.useToken();
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { imeEnterDecision, imeCompositionProps } = useImeGuard();
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  /** 附件待发区（📎/拖拽/粘贴三入口汇合；去重按路径，上限与壳侧同步 20） */
  const [pending, setPending] = useState<StripItem[]>([]);
  const addPaths = async (paths: string[]) => {
    const fresh = paths.filter((p) => !pending.some((x) => x.path === p));
    if (fresh.length === 0) return;
    if (pending.length + fresh.length > MAX_ATTACHMENTS) {
      antdMessage.warning(`附件过多（最多 ${MAX_ATTACHMENTS} 个）`);
      return;
    }
    try {
      const metas = await statAttachments(fresh);
      setPending((prev) => [...prev, ...metas]);
    } catch (e: unknown) {
      antdMessage.error(e instanceof Error ? e.message : String(e));
    }
  };
  // 原生拖拽（窗口 dragDropEnabled=true，HTML5 onDrop 不触发）与剪贴板图片
  const dragOver = useFileDrop(!disabled, (paths) => void addPaths(paths));
  useImagePaste(!disabled, (bytes) => {
    void savePastedImage(bytes)
      .then((path) => addPaths([path]))
      .catch((e: unknown) => antdMessage.error(e instanceof Error ? e.message : String(e)));
  });

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
    // 发送条件：文字或附件至少一项（仅附件无文字也发——RT 侧占位提示模型）
    if (disabled || (!trimmed && pending.length === 0)) return;
    // 斜杠命令解析：/name args... 命中→模板渲染；未命中原样（普通消息）
    let outgoing = trimmed;
    if (trimmed.startsWith('/')) {
      const [head, ...args] = trimmed.split(/\s+/);
      const cmd = commands.find((c) => c.name === head.slice(1));
      if (cmd) outgoing = renderCommand(cmd, args);
    }
    const attachments: AttachmentPayload[] = pending.map(({ path, name, size, kind }) => ({
      path,
      name,
      size,
      kind,
    }));
    const result = onSend(outgoing, attachments);
    setText('');
    setPending([]);
    setSlashOpen(false);
    taRef.current?.focus();
    if (result && typeof result.then === 'function') {
      // 未发出（resolve false / 抛错）→ 还原用户所输原文与附件（非斜杠渲染后的模板）
      void result.then(
        (sent) => {
          if (sent === false) {
            setText(text);
            setPending(pending);
          }
        },
        () => {
          setText(text);
          setPending(pending);
        },
      );
    }
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
      style={
        centered
          ? {
              // 居中浮卡（无历史时的欢迎输入框）：圆角描边+投影，不带横条分隔线
              flexShrink: 0,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 12,
              boxShadow: token.boxShadowSecondary,
              padding: '8px 12px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              background: token.colorBgContainer,
            }
          : {
              flexShrink: 0,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              padding: '8px 12px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              background: token.colorBgContainer,
            }
      }
    >
      {pending.length > 0 ? (
        <AttachmentStrip items={pending} onRemove={(p) => setPending((prev) => prev.filter((x) => x.path !== p))} />
      ) : null}
      {dragOver ? (
        <div
          aria-hidden
          style={{
            marginBottom: 6,
            padding: '14px 10px',
            borderRadius: 10,
            border: `1px dashed ${token.colorPrimary}`,
            background: `color-mix(in srgb, ${token.colorPrimary} 8%, transparent)`,
            textAlign: 'center',
            fontSize: 12,
            color: token.colorPrimary,
          }}
        >
          松开以附加文件
        </div>
      ) : null}
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
        autoFocus={autoFocus}
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
        {/* 左：权限模式 + 运行态状态条（D36 上下文用量，靠近输入区） */}
        <Flex align="center" gap={8} wrap style={{ minWidth: 0 }}>
          {modePicker}
          {statusInfo}
        </Flex>
        {/* 模型 chip 紧挨操作区（2026-11-12 用户口径：靠近发送按钮） */}
        <Flex align="center" gap={8}>
          {modelPicker}
          <Flex gap={8}>
            <Button
              variant="secondary"
              onClick={() => {
                if (disabled) return;
                void pickAttachmentPaths().then((paths) => {
                  if (paths.length > 0) void addPaths(paths);
                });
              }}
              title="附加文件（也可拖入或粘贴）"
            >
              <Paperclip size={12} aria-hidden />
            </Button>
            {/* 停止（红色）：中断当前回答，会话保留可继续 */}
            {canStop ? (
              <Button variant="danger" onClick={onStop}>
                <Square size={12} aria-hidden />
                停止
              </Button>
            ) : null}
            <Button onClick={submit} disabled={disabled || (!text.trim() && pending.length === 0)}>
              <Send size={12} aria-hidden />
              发送
            </Button>
          </Flex>
        </Flex>
      </Flex>
    </div>
  );
}
