/**
 * 消息输入区（D03 §3.1；D26-O7 全量 antd 换装）：
 * - Enter 发送 / Shift+Enter 换行（D01 §9）；IME 组合窗防误发（useImeGuard 原样保留）
 * - textarea → antd Input.TextArea（autoSize；键盘/光标/选区操作经 ref 直达原生 textarea 保真）
 * - 引用回复条（INT-IM-04）：replyTo 悬浮于输入框上，可关闭（内联 Flex + token）
 * - 编辑态（INT-IM-02）：原 bubble 文本转入输入框，Enter 提交 PATCH
 * - 正在输入（INT-IM-11）：输入事件 2.5s 节流发 msg.typing（stop 不发，静默；群聊默认关，OQ-B03）
 * - @提及（INT-IM-24）：输入 @ 触发成员过滤面板（参与者取自已加载消息的去重发送者）
 * - 草稿存 feature store（500ms 防抖 PATCH state 多端同步，INT-IM-10）
 * - 禁言态 → antd Alert；工具条 → Button(text/icon)+Tooltip；@/斜杠面板自绘内联（键盘导航保真）
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, Flex, Input, Tooltip, Typography, theme } from 'antd';
import type { InputRef } from 'antd';
import { AtSign, Bot, Mic, Paperclip, Smile, Square, Trash2, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { useImeGuard } from '../../../shared/hooks/useImeGuard';
import { sendTyping } from '../api/im';
import type { Message } from '../model/types';
import { EmojiPicker } from './EmojiPicker';
import type { StickerItem } from '../api/stickers';

const { Text } = Typography;

/** 语音条上限（60s；服务端 Send 同规则兜底） */
const VOICE_MAX_MS = 60_000;
/** 短于 1s 视为误触丢弃 */
const VOICE_MIN_MS = 800;

/** 录音容器后缀（Safari/WKWebView=mp4，Chrome=webm） */
function voiceExtOf(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/** 斜杠命令表（2026-11-11：/agent 进入/退出机器人对话模式；@Agent 触发已下线留作他用） */
const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/agent', desc: '进入与机器人对话模式（再次执行取消）' },
];

/**
 * antd TextArea ref（结构子集）：focus 走 antd 封装，光标/选区直达底层原生
 * textarea——insertText/@回填/斜杠补全的光标操作与原生路径完全一致（保真）。
 */
interface TaRefLike {
  focus: (options?: unknown) => void;
  resizableTextArea?: { textArea: HTMLTextAreaElement | null };
}

interface MessageInputProps {
  convId: string;
  /** 正在输入上报（INT-IM-11）：群聊默认关（OQ-B03 拍板——大群 typing 广播收益低、扰动高），单聊保持 2.5s 节流 */
  typingEnabled?: boolean;
  /** 广播群普通成员等只读场景（PIM-04：仅发布者可发言） */
  disabled?: boolean;
  disabledHint?: string;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  /** 引用回复目标（null=普通发送）；发送后由父层清除 */
  replyTo: Message | null;
  onCancelReply: () => void;
  /** 编辑目标（null=普通发送）；Enter 提交 onEditSubmit 后由父层清除 */
  editing: Message | null;
  onCancelEdit: () => void;
  onEditSubmit: (text: string) => void;
  /** @提及候选（uid→名称；空则 @ 面板不出现） */
  mentionCandidates: Array<{ uid: string; name: string }>;
  /** @选择后回填（写入 mentions range 由父层随发送携带） */
  onMentionPicked?: (uid: string, name: string) => void;
  /** 附件选择（D06：file input → 父层 FileSendPreview 预览弹层） */
  onPickFile?: (file: File) => void;
  /** 语音条发送（audio_clip：父层走 upload→msg.send，气泡由 msg.new 回流） */
  onSendVoice?: (file: File, durationMs: number) => void;
  /** 表情包点击即发送（0022 sticker；不传=表情面板无「表情包」页签） */
  onPickSticker?: (item: StickerItem) => void;
  /** Agent 模式（D18 §3.1）：点亮后本条消息交给内嵌 Agent 处理（不传=不显示入口） */
  agentMode?: boolean;
  onToggleAgentMode?: () => void;
}

export function MessageInput({
  convId,
  typingEnabled = true,
  disabled = false,
  disabledHint,
  draft,
  onDraftChange,
  onSend,
  replyTo,
  onCancelReply,
  editing,
  onCancelEdit,
  onEditSubmit,
  mentionCandidates,
  onMentionPicked,
  onPickFile,
  onSendVoice,
  onPickSticker,
  agentMode,
  onToggleAgentMode,
}: MessageInputProps) {
  const { token } = theme.useToken();
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** 录音态（recorder 引用经 ref 持有，state 仅驱动 UI） */
  const [recording, setRecording] = useState(false);
  const [voiceSec, setVoiceSec] = useState(0);
  /** 录音失败提示（权限/不支持；3s 自清） */
  const [voiceErr, setVoiceErr] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startedAtRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const cancelFlagRef = useRef(false);
  const voiceTimerRef = useRef<number | null>(null);
  /** @面板：起始位置 + 过滤词（截到最后一个 @ 之后的片段） */
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  /** 斜杠命令面板（2026-11-11：/ 开头且未断词时开启） */
  const [slashOpen, setSlashOpen] = useState(false);
  const taRef = useRef<TaRefLike>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingAt = useRef(0);

  /** 底层原生 textarea（光标/选区操作直达；antd 封装下同样持有 selectionStart 等） */
  const taEl = () => taRef.current?.resizableTextArea?.textArea ?? null;
  const focusTa = () => taRef.current?.focus();

  // 编辑态：原文本转入输入框（离开编辑态不动草稿）
  useEffect(() => {
    if (editing && 'text' in editing.body) {
      onDraftChange(editing.body.text);
      focusTa();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.msgId]);

  const mentionList = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const members = mentionCandidates
      .filter((c) => c.name.toLowerCase().includes(q) || c.uid.includes(q))
      .slice(0, 6);
    return members;
  }, [mention, mentionCandidates]);

  const doSend = () => {
    if (editing) {
      const text = draft.trim();
      if (text) onEditSubmit(text);
      return;
    }
    const text = draft.trim();
    if (!text || disabled || sending) return;
    onSend(text);
    onDraftChange(''); // 清空草稿（发送成功或手动清空同步空串，INT-IM-10）
    setMention(null);
    setSending(true);
    setTimeout(() => setSending(false), 300); // 乐观更新即时上屏，此处仅做按钮态节流
  };

  /** typing 节流 2.5s（INT-IM-11；stop 不发）；群聊 typingEnabled=false 不上报（OQ-B03） */
  const maybeTyping = () => {
    if (!typingEnabled) return;
    const now = Date.now();
    if (now - lastTypingAt.current >= 2500) {
      lastTypingAt.current = now;
      sendTyping(convId);
    }
  };

  // ── 语音条（audio_clip）：点击 Mic 开始 → 工具条切录音条 → 完成/取消/60s 自动停 ──

  const stopVoice = (cancel: boolean) => {
    cancelFlagRef.current = cancel;
    recorderRef.current?.stop(); // 收尾（取流释放/上抛）在 onstop
  };

  const clearVoiceTimer = () => {
    if (voiceTimerRef.current !== null) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  };

  const startVoice = async () => {
    if (recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceErr('当前环境不支持录音');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      cancelFlagRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      startedAtRef.current = Date.now();
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearVoiceTimer();
        setRecording(false);
        setVoiceSec(0);
        const canceled = cancelFlagRef.current;
        const duration = Date.now() - startedAtRef.current;
        recorderRef.current = null;
        if (canceled || duration < VOICE_MIN_MS || chunksRef.current.length === 0) return;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const ext = voiceExtOf(recorder.mimeType || 'audio/webm');
        onSendVoice?.(new File([blob], `voice-${startedAtRef.current}.${ext}`, { type: blob.type }), duration);
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setVoiceSec(0);
      voiceTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAtRef.current;
        setVoiceSec(Math.floor(elapsed / 1000));
        if (elapsed >= VOICE_MAX_MS) stopVoice(false);
      }, 250);
    } catch {
      setVoiceErr('无法访问麦克风（请检查系统权限）');
    }
  };

  // 卸载兜底：录音中离开页面释放麦克风与定时器
  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        cancelFlagRef.current = true;
        recorderRef.current.stop();
      }
      clearVoiceTimer();
    },
    [],
  );

  // 录音失败提示 3s 自清
  useEffect(() => {
    if (!voiceErr) return;
    const t = setTimeout(() => setVoiceErr(''), 3000);
    return () => clearTimeout(t);
  }, [voiceErr]);

  /** @面板探测（INT-IM-24；全角＠归一）。输入与工具条插入共用——此前仅
   * textarea onChange 触发，@按钮直插 draft 不弹面板（2026-11-10 真机反馈） */
  const detectMention = (v: string, cursor: number) => {
    const before = v.slice(0, cursor).replaceAll('＠', '@');
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1] ?? ' '))) {
      const query = before.slice(at + 1);
      if (!query.includes(' ') && query.length <= 12) {
        setMention({ start: at, query });
        setMentionIdx(0);
        return;
      }
    }
    setMention(null);
  };

  const insertText = (insert: string) => {
    const ta = taEl();
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + insert + draft.slice(end);
    onDraftChange(next);
    if (insert.includes('@')) detectMention(next, start + insert.length); // 工具条插入同触发面板
    requestAnimationFrame(() => {
      if (ta) {
        ta.selectionStart = ta.selectionEnd = start + insert.length;
        ta.focus();
      }
    });
  };

  const onChange = (v: string) => {
    // /agent 命令补全（空格即执行）：切换 Agent 模式（再执行=取消）并吃掉命令词
    const cmd = v.match(/^\/agent([\s　]|$)/);
    if (cmd) {
      onToggleAgentMode?.();
      const rest = v.slice(cmd[0].length);
      onDraftChange(rest);
      requestAnimationFrame(() => {
        const ta = taEl();
        if (ta) {
          ta.selectionStart = ta.selectionEnd = rest.length;
          ta.focus();
        }
      });
      return;
    }
    onDraftChange(v);
    maybeTyping();
    const pos = taEl()?.selectionStart ?? v.length;
    detectMention(v, pos);
    setSlashOpen(/^\/[a-z]*$/i.test(v));
  };

  /** 斜杠命令命中列表（输入 / 即出提示面板） */
  const slashMatches = useMemo(
    () => (slashOpen ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(draft.toLowerCase())) : []),
    [slashOpen, draft],
  );

  /** 执行命令（面板点击/Enter）：/agent=切换模式+清草稿 */
  const execSlash = (cmd: string) => {
    if (cmd === '/agent') onToggleAgentMode?.();
    onDraftChange('');
    setSlashOpen(false);
    requestAnimationFrame(() => focusTa());
  };

  const pickMention = (uid: string, name: string) => {
    if (mention) {
      const pos = taEl()?.selectionStart ?? draft.length;
      const before = draft.slice(0, pos);
      const after = draft.slice(pos);
      const replaced = `${before.slice(0, mention.start)}@${name} ${after}`;
      onDraftChange(replaced);
      onMentionPicked?.(uid, name);
      setMention(null);
      requestAnimationFrame(() => {
        const ta = taEl();
        if (ta) {
          const caret = mention.start + name.length + 2;
          ta.selectionStart = ta.selectionEnd = caret;
          ta.focus();
        }
      });
    }
  };

  const { imeEnterDecision, imeCompositionProps } = useImeGuard();
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // @面板导航：↑↓（Enter/Esc 归入下方统一处理；D03 §3.2 富文本输入框）
    if (mention && mentionList.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionList.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionList.length) % mentionList.length);
        return;
      }
    }
    // Enter 三态（useImeGuard v3）：ime=组合中交给输入法；swallow=确认键余波，吞掉不换行；
    // send=按面板优先级执行（@选中 > 斜杠执行 > 发送）
    if (e.key === 'Enter' && !e.shiftKey) {
      const d = imeEnterDecision(e.nativeEvent);
      if (d === 'swallow') {
        e.preventDefault();
        return;
      }
      if (d === 'send') {
        e.preventDefault();
        if (mention && mentionList.length > 0) {
          const it = mentionList[mentionIdx];
          pickMention(it.uid, it.name);
          return;
        }
        if (slashMatches.length > 0) {
          execSlash(slashMatches[0].cmd);
          return;
        }
        doSend();
      }
      return;
    }
    if (e.key === 'Escape') {
      // 面板逐个关（@优先），全关后 Esc 才取消编辑
      if (mention && mentionList.length > 0) {
        setMention(null);
        return;
      }
      if (emojiOpen) setEmojiOpen(false);
      if (slashMatches.length > 0) setSlashOpen(false);
      if (editing) onCancelEdit();
    }
  };

  /** 面板浮层公共内联样式（锚定输入区容器 absolute；原自研面板类退役） */
  const panelStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: 12,
    zIndex: 20,
    minWidth: 220,
    background: token.colorBgContainer,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadius,
    boxShadow: token.boxShadowSecondary,
    overflow: 'hidden',
  };

  if (disabled) {
    return (
      <div style={{ flexShrink: 0, borderTop: `1px solid ${token.colorBorderSecondary}`, padding: '8px 12px' }}>
        <Alert type="info" showIcon message={disabledHint ?? '该会话仅发布者可发言'} />
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative', // @提及/表情/斜杠面板 absolute 锚定基准（缺失则漂到窗口左上，2026-11-10 真机）
        flexShrink: 0,
        borderTop: `1px solid ${agentMode ? `color-mix(in srgb, ${token.colorPrimary} 45%, transparent)` : token.colorBorderSecondary}`,
        padding: '8px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: agentMode ? `color-mix(in srgb, ${token.colorPrimary} 6%, transparent)` : undefined,
      }}
    >
      {/* 引用回复条 / 编辑条（互斥；编辑优先） */}
      {editing ? (
        <Flex
          align="center"
          gap={8}
          style={{
            padding: '4px 8px',
            background: token.colorFillQuaternary,
            borderLeft: `3px solid ${token.colorWarning}`,
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <span style={{ color: token.colorWarning, fontWeight: 500, flexShrink: 0 }}>编辑消息</span>
          <Button variant="text" size="small" title="取消编辑 (Esc)" style={{ padding: 2, height: 'auto', color: token.colorTextQuaternary }} onClick={onCancelEdit}>
            <X size={13} />
          </Button>
        </Flex>
      ) : replyTo ? (
        <Flex
          align="center"
          gap={8}
          style={{
            padding: '4px 8px',
            background: token.colorFillQuaternary,
            borderLeft: `3px solid ${token.colorPrimary}`,
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <span style={{ color: token.colorPrimary, fontWeight: 500, flexShrink: 0 }}>回复 {replyTo.senderName}</span>
          <span style={{ color: token.colorTextSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {replyTo.ext?.reply_digest ? '' : 'text' in replyTo.body ? replyTo.body.text.slice(0, 60) : ''}
          </span>
          <Button variant="text" size="small" title="取消回复" style={{ padding: 2, height: 'auto', color: token.colorTextQuaternary }} onClick={onCancelReply}>
            <X size={13} />
          </Button>
        </Flex>
      ) : null}

      <Flex gap={4} align="center">
        {onToggleAgentMode ? (
          <Tooltip title={agentMode ? 'Agent 模式已开启（点击关闭）' : 'Agent 模式：本条消息交给 AI 处理'}>
            <Button
              variant="text"
              size="small"
              data-testid="agent-mode-btn"
              style={{
                width: 28,
                height: 28,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: agentMode ? token.colorPrimary : token.colorTextSecondary,
                background: agentMode ? 'var(--bbc-primary-light)' : 'transparent',
              }}
              onClick={() => onToggleAgentMode()}
            >
              <Bot size={17} />
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip title="表情">
          <Button
            variant="text"
            size="small"
            style={{ width: 28, height: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextSecondary }}
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Smile size={17} />
          </Button>
        </Tooltip>
        <Tooltip title="提及 @（输入 @ 也触发）">
          <Button
            variant="text"
            size="small"
            style={{ width: 28, height: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextSecondary }}
            onClick={() => insertText('@')}
          >
            <AtSign size={17} />
          </Button>
        </Tooltip>
        <Tooltip title="发送文件/图片">
          <Button
            variant="text"
            size="small"
            data-testid="attach-btn"
            style={{ width: 28, height: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextSecondary }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={17} />
          </Button>
        </Tooltip>
        {/* 附件选择（D06）：选中后进 FileSendPreview 预览弹层；value 置空允许重选同一文件 */}
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          data-testid="attach-input"
          accept="*/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onPickFile?.(f);
          }}
        />
        <Tooltip title="语音（最长 60 秒）">
          <Button
            variant="text"
            size="small"
            data-testid="voice-btn"
            style={{ width: 28, height: 28, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextSecondary }}
            onClick={() => void startVoice()}
          >
            <Mic size={17} />
          </Button>
        </Tooltip>
        {/* 机器人模式徽标（行末右上角；margin-left:auto 只推自己，操作按钮保持原位） */}
        {agentMode ? (
          <Button
            size="small"
            data-testid="agent-mode-badge"
            title="机器人对话模式中，点击退出"
            style={{
              marginInlineStart: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              padding: '2px 8px',
              height: 'auto',
              borderRadius: 999,
              color: token.colorPrimary,
              background: `color-mix(in srgb, ${token.colorPrimary} 10%, transparent)`,
              border: `1px solid color-mix(in srgb, ${token.colorPrimary} 35%, transparent)`,
            }}
            onClick={() => onToggleAgentMode?.()}
          >
            <Bot size={12} />
            机器人对话模式
          </Button>
        ) : null}
      </Flex>

      {/* 录音条（语音进行中替代输入提示；完成=上抛发送，取消/超短丢弃） */}
      {recording ? (
        <Flex
          align="center"
          gap={8}
          data-testid="voice-bar"
          style={{
            padding: '6px 10px',
            background: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            fontSize: 13,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorError }} />
          <span style={{ flex: 1, fontVariantNumeric: 'tabular-nums', color: token.colorTextSecondary }}>
            录音中 {Math.floor(voiceSec / 60)}:{String(voiceSec % 60).padStart(2, '0')} / 1:00
          </span>
          <Button variant="text" size="small" title="取消（丢弃）" style={{ color: token.colorTextSecondary }} icon={<Trash2 size={14} />} onClick={() => stopVoice(true)} />
          <Button
            variant="primary"
            size="small"
            title="完成并发送"
            data-testid="voice-send"
            style={{ width: 24, height: 24, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            icon={<Square size={12} fill="currentColor" />}
            onClick={() => stopVoice(false)}
          />
        </Flex>
      ) : null}
      {voiceErr ? (
        <Alert type="error" message={voiceErr} style={{ fontSize: 12 }} />
      ) : null}

      {/* 分栏 emoji 选择器（INT-IM-25 完整版 + 0022 表情包）：插入/发送后不关面板，Smile 按钮/Esc 关闭 */}
      {emojiOpen ? (
        <div
          style={{
            padding: 4,
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
          }}
        >
          <EmojiPicker onPick={(e) => insertText(e)} onPickSticker={onPickSticker} />
        </div>
      ) : null}

      {mention && mentionList.length > 0 ? (
        <div style={panelStyle}>
          {mentionList.map((c, i) => (
            <button
              key={c.uid}
              type="button"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 10px',
                border: 'none',
                background: i === mentionIdx ? token.colorFillTertiary : 'transparent',
                cursor: 'pointer',
                fontSize: 13,
              }}
              onMouseEnter={() => setMentionIdx(i)}
              onClick={() => pickMention(c.uid, c.name)}
            >
              <span style={{ color: token.colorText }}>{c.name}</span>
              <span style={{ color: token.colorTextQuaternary, fontSize: 12 }}>{c.uid}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* 斜杠命令面板（2026-11-11：/ 提示；Enter/点击执行） */}
      {slashMatches.length > 0 ? (
        <div style={panelStyle} data-testid="slash-panel">
          {slashMatches.map((c) => (
            <button
              key={c.cmd}
              type="button"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 10px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 13,
              }}
              onClick={() => execSlash(c.cmd)}
            >
              <span style={{ color: token.colorText, display: 'inline-flex', alignItems: 'center' }}>
                <Bot size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                {c.cmd}
              </span>
              <span style={{ color: token.colorTextQuaternary, fontSize: 12 }}>
                {agentMode ? '当前已在机器人模式，执行=退出' : c.desc}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <Input.TextArea
        ref={taRef as React.Ref<InputRef>}
        data-testid="chat-input-textarea"
        autoSize={{ minRows: 3, maxRows: 10 }}
        placeholder={editing ? '编辑消息…（Esc 取消）' : `写入 ${convId} …`}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        {...imeCompositionProps}
      />
      <Flex justify="space-between" align="center" gap={8}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {editing ? 'Enter 保存编辑，Esc 取消' : 'Enter 发送，Shift + Enter 换行'}
        </Text>
        <Button onClick={doSend} disabled={!draft.trim() || sending}>
          {editing ? '保存' : '发送'}
        </Button>
      </Flex>
    </div>
  );
}
