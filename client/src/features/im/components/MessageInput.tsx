/**
 * 消息输入区（D03 §3.1）：
 * - Enter 发送 / Shift+Enter 换行（D01 §9）
 * - 引用回复条（INT-IM-04）：replyTo 悬浮于输入框上，可关闭
 * - 编辑态（INT-IM-02）：原 bubble 文本转入输入框，Enter 提交 PATCH
 * - 正在输入（INT-IM-11）：输入事件 2.5s 节流发 msg.typing（stop 不发，静默）
 * - @提及（INT-IM-24）：输入 @ 触发成员过滤面板（参与者取自已加载消息的去重发送者）
 * - 草稿存 feature store（500ms 防抖 PATCH state 多端同步，INT-IM-10）
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AtSign, Mic, Paperclip, Smile, Square, Trash2, X } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import { sendTyping } from '../api/im';
import type { Message } from '../model/types';
import { EmojiPicker } from './EmojiPicker';

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

interface MessageInputProps {
  convId: string;
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
}

export function MessageInput({
  convId,
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
}: MessageInputProps) {
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
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTypingAt = useRef(0);

  // 编辑态：原文本转入输入框（离开编辑态不动草稿）
  useEffect(() => {
    if (editing && 'text' in editing.body) {
      onDraftChange(editing.body.text);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.msgId]);

  const mentionList = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return mentionCandidates.filter((c) => c.name.toLowerCase().includes(q) || c.uid.includes(q)).slice(0, 6);
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

  /** typing 节流 2.5s（INT-IM-11；stop 不发） */
  const maybeTyping = () => {
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

  const insertText = (insert: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? draft.length;
    const end = ta.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + insert + draft.slice(end);
    onDraftChange(next);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + insert.length;
      ta.focus();
    });
  };

  const onChange = (v: string) => {
    onDraftChange(v);
    maybeTyping();
    // @面板探测：光标前最近一个未闭合的 @（INT-IM-24）
    const pos = taRef.current?.selectionStart ?? v.length;
    const before = v.slice(0, pos);
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

  const pickMention = (uid: string, name: string) => {
    if (mention) {
      const pos = taRef.current?.selectionStart ?? draft.length;
      const before = draft.slice(0, pos);
      const after = draft.slice(pos);
      const replaced = `${before.slice(0, mention.start)}@${name} ${after}`;
      onDraftChange(replaced);
      onMentionPicked?.(uid, name);
      setMention(null);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          const caret = mention.start + name.length + 2;
          ta.selectionStart = ta.selectionEnd = caret;
          ta.focus();
        }
      });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // @面板导航：↑↓ + Enter 选择，Esc 关闭（D03 §3.2 富文本输入框）
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
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const it = mentionList[mentionIdx];
        pickMention(it.uid, it.name);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (e.key === 'Escape' && emojiOpen) {
      setEmojiOpen(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSend();
    }
    if (e.key === 'Escape' && editing) {
      onCancelEdit();
    }
  };

  if (disabled) {
    return (
      <div className="message-input">
        <div className="message-input__muted">{disabledHint ?? '该会话仅发布者可发言'}</div>
      </div>
    );
  }

  return (
    <div className="message-input">
      {/* 引用回复条 / 编辑条（互斥；编辑优先） */}
      {editing ? (
        <div className="input-context-bar input-context-bar--edit">
          <span className="input-context-bar__label">编辑消息</span>
          <button type="button" className="input-context-bar__close" onClick={onCancelEdit} title="取消编辑 (Esc)">
            <X size={13} />
          </button>
        </div>
      ) : replyTo ? (
        <div className="input-context-bar">
          <span className="input-context-bar__label">回复 {replyTo.senderName}</span>
          <span className="input-context-bar__digest">
            {replyTo.ext?.reply_digest ? '' : 'text' in replyTo.body ? replyTo.body.text.slice(0, 60) : ''}
          </span>
          <button type="button" className="input-context-bar__close" onClick={onCancelReply} title="取消回复">
            <X size={13} />
          </button>
        </div>
      ) : null}

      <div className="message-input__tools">
        <button className="tool-btn" title="表情" type="button" onClick={() => setEmojiOpen((v) => !v)}>
          <Smile size={17} />
        </button>
        <button className="tool-btn" title="提及 @（输入 @ 也触发）" type="button" onClick={() => insertText('@')}>
          <AtSign size={17} />
        </button>
        <button
          className="tool-btn"
          title="发送文件/图片"
          type="button"
          data-testid="attach-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={17} />
        </button>
        {/* 附件选择（D06）：选中后进 FileSendPreview 预览弹层；value 置空允许重选同一文件 */}
        <input
          ref={fileInputRef}
          type="file"
          className="attach-input"
          data-testid="attach-input"
          accept="*/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onPickFile?.(f);
          }}
        />
        <button className="tool-btn" title="语音（最长 60 秒）" type="button" data-testid="voice-btn" onClick={() => void startVoice()}>
          <Mic size={17} />
        </button>
      </div>

      {/* 录音条（语音进行中替代输入提示；完成=上抛发送，取消/超短丢弃） */}
      {recording ? (
        <div className="voice-bar" data-testid="voice-bar">
          <span className="voice-bar__dot" />
          <span className="voice-bar__time">
            录音中 {Math.floor(voiceSec / 60)}:{String(voiceSec % 60).padStart(2, '0')} / 1:00
          </span>
          <button type="button" className="voice-bar__btn" title="取消（丢弃）" onClick={() => stopVoice(true)}>
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            className="voice-bar__btn voice-bar__btn--send"
            title="完成并发送"
            data-testid="voice-send"
            onClick={() => stopVoice(false)}
          >
            <Square size={12} fill="currentColor" />
          </button>
        </div>
      ) : null}
      {voiceErr ? <div className="voice-bar__error">{voiceErr}</div> : null}

      {/* 分栏 emoji 选择器（INT-IM-25 完整版）：插入不关面板便于连续输入，Smile 按钮/Esc 关闭 */}
      {emojiOpen ? (
        <div className="emoji-panel">
          <EmojiPicker onPick={(e) => insertText(e)} />
        </div>
      ) : null}

      {mention && mentionList.length > 0 ? (
        <div className="mention-panel">
          {mentionList.map((c, i) => (
            <button
              key={c.uid}
              type="button"
              className={`mention-panel__item${i === mentionIdx ? ' mention-panel__item--active' : ''}`}
              onMouseEnter={() => setMentionIdx(i)}
              onClick={() => pickMention(c.uid, c.name)}
            >
              <span className="mention-panel__name">{c.name}</span>
              <span className="mention-panel__uid">{c.uid}</span>
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        ref={taRef}
        className="message-input__textarea"
        rows={3}
        placeholder={editing ? '编辑消息…（Esc 取消）' : `写入 ${convId} …`}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="message-input__foot">
        <span className="message-input__hint">{editing ? 'Enter 保存编辑，Esc 取消' : 'Enter 发送，Shift + Enter 换行'}</span>
        <Button onClick={doSend} disabled={!draft.trim() || sending}>
          {editing ? '保存' : '发送'}
        </Button>
      </div>
    </div>
  );
}
