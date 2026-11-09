/**
 * 消息气泡族（D03 §3.2）：
 * - text：己方 primary 浅底 / 对方 gray-2，圆角 12 带 4 尾巴
 * - 引用条：reply_to_seq + ext.reply_digest 快照，点击定位原消息（INT-IM-04）
 * - 表情回应条：ext.reactions 全量快照渲染，点击增删本人（INT-IM-23）
 * - 已编辑角标 / 撤回占位（store 已转 system 形态）/ merge_forward 卡片
 * - @提及高亮：mentions.range 内文本主色+底纹（INT-IM-24）
 * - 悬浮操作条（瘦身，INT-IM-25）：快捷 emoji + 回复 + ⋯（打开统一右键菜单；
 *   编辑/撤回/转发/收藏/多选移入菜单，显隐与菜单共用 msgActionsVisible）
 * - 右键/长按 500ms 打开统一菜单（system 仅复制、撤回占位无菜单——hasAnyMsgAction 判定）
 * - 文件卡片可拖出（draggable → dataTransfer 文件 id，拖到系统=下载票据触发，D06 承接）
 * - 本地态尾标：sending 灰钟 → sent ✓ → 对方已读 ✓✓（msg.receipt，04 篇 §4.2）；failed 红叹号（点击重试，INT-IM-01a）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowDownToLine,
  Bot,
  Check,
  CheckCheck,
  Clock3,
  FileText,
  Image as ImageIcon,
  ListOrdered,
  Mic,
  MoreHorizontal,
  Pause,
  Phone,
  Play,
  RotateCcw,
  SmilePlus,
  Video,
} from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { getErrorText } from '../../../shared/api/http';
import { formatBytes } from '../../../shared/utils/format';
import { CallCard, type CallCardBody } from '../../../shared/components/CallCard';
import { emit } from '../../../shared/bus';
import { digestOf } from '../store/im';
import { systemMessageText } from '../pages/systemMessageRegistry';
import { downloadUrl, getDownloadTicket } from '../api/files';
import { ApplyCard } from './ApplyCard';
import { EmojiPicker } from './EmojiPicker';
import { hasAnyMsgAction, msgActionsVisible } from './stream/msgActions';
import type { MenuAnchor } from './stream/MsgContextMenu';
import type {
  FileMessageBody,
  MemberRole,
  Mention,
  Message,
  MergeForwardBody,
  SystemBody,
} from '../model/types';

/** 快捷回应候选（与飞书同款常用集，选择器全集在 MsgActions） */
export const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏'] as const;

/** 消息类型→列表图标（PIM-11 抽屉子条目 / 合并转发卡片 digest 前缀共用） */
export function mergeTypeIcon(type: string) {
  switch (type) {
    case 'image':
      return <ImageIcon size={13} />;
    case 'file':
      return <FileText size={13} />;
    case 'audio_clip':
      return <Mic size={13} />;
    case 'video':
      return <Video size={13} />;
    case 'agent_card':
      return <Bot size={13} />;
    case 'merge_forward':
      return <ListOrdered size={13} />;
    case 'call_card':
      return <Phone size={13} />;
    default:
      return null; // text：无类型图标，直接展示文本 digest
  }
}

export interface BubbleActions {
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onRecall: (m: Message) => void;
  onForward: (m: Message) => void;
  onReact: (m: Message, emoji: string) => void;
  onLocate: (seq: number) => void;
  /** 收藏（PIM-08 INT-IM-06：悬浮操作条「收藏」；幂等，撤回消息亦可收藏） */
  onFavorite: (m: Message) => void;
  /** 进入多选（INT-IM-14/PIM-10：悬浮操作条「多选」） */
  onMultiSelect: (m: Message) => void;
  /** 打开合并转发详情抽屉（PIM-11：merge_forward 气泡点击） */
  onOpenMergeDetail: (m: Message) => void;
}

interface MessageBubbleProps {
  message: Message;
  mine: boolean;
  onRetry: (clientMsgId: string) => void;
  /** 对方已读游标（msg.receipt 维护）：mine 且 sent 且 seq ≤ 此值 → ✓✓ */
  peerReadSeq?: number;
  /** 悬浮操作（system/撤回占位不出） */
  actions?: BubbleActions;
  /** 当前用户（回应是否已含本人的判定） */
  myUid: string;
  /** 系统消息上下文：审批卡（PIM-06）角色与终态回显 */
  myRole?: MemberRole;
  applyHandled?: 'approved' | 'rejected';
  onApplyHandled?: (applyId: string, result: 'approved' | 'rejected') => void;
  /** 多选模式态（INT-IM-14）：active=复选框浮层 + 行点击切换；selected=勾选样式 */
  multiSelect?: { active: boolean; selected: boolean };
  /** 多选勾选/取消（active 时行点击与复选框共用） */
  onSelectToggle?: (m: Message) => void;
  /** 打开已读回执面板（API-IM-06：群聊消息尾标点击；单聊不传=尾标不可点） */
  onOpenReceipts?: (m: Message) => void;
  /** 打开统一右键菜单（INT-IM-25）：右键/长按 500ms/悬浮条 ⋯ 三入口共用；
   *  system（仅复制）可开、撤回占位不可开——由 hasAnyMsgAction 判定 */
  onOpenMsgMenu?: (m: Message, at: MenuAnchor) => void;
}

/**
 * 长按 500ms 合成菜单锚点（INT-IM-25 触屏路径；桌面右键走 contextmenu）。
 * 长按触发后 touchend preventDefault 抑制合成 click——防随后的点击误触行内交互/误关菜单。
 */
function useLongPressMenu(open: ((at: MenuAnchor) => void) | null) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  useEffect(() => clear, [clear]);
  if (!open) return {};
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      firedRef.current = false;
      clear();
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        open({ x: t.clientX, y: t.clientY });
      }, 500);
    },
    onTouchMove: clear,
    onTouchCancel: clear,
    onTouchEnd: (e: React.TouchEvent) => {
      clear();
      if (firedRef.current) e.preventDefault();
    },
  };
}

/** 本地态/服务端态尾标（✓✓=对方已读，单聊回执；群聊可点开已读面板 API-IM-06） */
function StateTag({
  message,
  onRetry,
  peerReadSeq = 0,
  onOpenReceipts,
}: {
  message: Message;
  onRetry: (id: string) => void;
  peerReadSeq?: number;
  onOpenReceipts?: (m: Message) => void;
}) {
  if (!message.localState) return null;
  if (message.localState === 'sending')
    return (
      <span className="msg-state" title="发送中">
        <Clock3 size={13} />
      </span>
    );
  if (message.localState === 'sent') {
    const read = peerReadSeq >= message.seq;
    const icon = read ? <CheckCheck size={14} /> : <Check size={14} />;
    const title = onOpenReceipts
      ? read
        ? '已读 · 点击查看名单'
        : '已送达 · 点击查看名单'
      : read
        ? '对方已读'
        : '已送达';
    // 群聊（onOpenReceipts 存在）：尾标可点开已读/未读名单面板（API-IM-06）
    if (onOpenReceipts) {
      return (
        <button
          type="button"
          className="msg-state msg-state--clickable"
          title={title}
          data-testid="receipt-tag"
          onClick={(e) => {
            e.stopPropagation();
            onOpenReceipts(message);
          }}
        >
          {icon}
        </button>
      );
    }
    return (
      <span className="msg-state" title={title}>
        {icon}
      </span>
    );
  }
  return (
    <span
      className="msg-state msg-state--failed"
      title={getErrorText(3007)}
      onClick={(e) => {
        e.stopPropagation();
        onRetry(message.clientMsgId);
      }}
    >
      <AlertCircle size={14} />
      <RotateCcw size={12} />
      重试
    </span>
  );
}

/** @提及高亮渲染：mentions.range（INT-IM-24） */
function TextWithMentions({ text, mentions }: { text: string; mentions?: Mention[] }) {
  if (!mentions || mentions.length === 0) return <>{text}</>;
  const parts: Array<{ s: string; mention?: Mention }> = [];
  let cursor = 0;
  const sorted = [...mentions].sort((a, b) => a.range[0] - b.range[0]);
  for (const m of sorted) {
    const [s, e] = m.range;
    if (s < cursor || s >= text.length || e <= s) continue;
    if (s > cursor) parts.push({ s: text.slice(cursor, s) });
    parts.push({ s: text.slice(s, e), mention: m });
    cursor = e;
  }
  if (cursor < text.length) parts.push({ s: text.slice(cursor) });
  return (
    <>
      {parts.map((p, i) =>
        p.mention ? (
          <span key={i} className="msg-mention">
            {p.s}
          </span>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  );
}

/** 引用条：ext.reply_digest 快照（点击定位；源已撤回时 digest 为固定文案） */
function ReplyQuote({ message, onLocate }: { message: Message; onLocate?: (seq: number) => void }) {
  const d = message.ext?.reply_digest;
  if (!d) return null;
  return (
    <div className="msg-quote" onClick={() => onLocate?.(d.seq)} role="button" tabIndex={0}>
      <span className="msg-quote__sender">{d.sender_name || d.sender_id}</span>
      <span className="msg-quote__digest">{d.digest}</span>
    </div>
  );
}

/** 表情回应条（INT-IM-23：不占 seq/不计未读；点击切换本人增删） */
function ReactionBar({ message, myUid, onReact }: { message: Message; myUid: string; onReact?: (emoji: string) => void }) {
  const reactions = message.ext?.reactions;
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <div className="msg-reactions">
      {Object.entries(reactions).map(([emoji, uids]) => (
        <button
          key={emoji}
          className={`msg-reactions__item${uids.includes(myUid) ? ' msg-reactions__item--mine' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onReact?.(emoji);
          }}
          title={uids.join('、')}
          type="button"
        >
          <span>{emoji}</span>
          {uids.length > 1 ? <span className="msg-reactions__count">{uids.length}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 合并转发卡片（PIM-10/PIM-11，D03 §3.2）：标题+count+前 3 条 digest 预览，点击 → PIM-11 抽屉 */
function MergeForwardCard({ message, onOpen }: { message: Message; onOpen?: (m: Message) => void }) {
  const b = 'items' in message.body ? (message.body as MergeForwardBody) : {};
  const items = b.items ?? [];
  const preview = items.slice(0, 3);
  return (
    <div
      className="msg-merge"
      data-testid="merge-forward-card"
      role="button"
      tabIndex={0}
      title="点击查看合并转发详情"
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(message);
      }}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.(message)}
    >
      <div className="msg-merge__title">
        <ListOrdered size={14} />
        {b.title ?? '聊天记录'} · {b.count ?? items.length} 条消息
      </div>
      {preview.map((it, i) => (
        <div className="msg-merge__item" key={i}>
          <span className="msg-merge__sender">{it.sender_name || it.sender_id}</span>
          <span className="msg-merge__digest">
            {mergeTypeIcon(it.type)}
            {it.digest}
          </span>
        </div>
      ))}
      <div className="msg-merge__hint">
        {items.length > 3 ? `共 ${items.length} 条，` : ''}点击查看详情
      </div>
    </div>
  );
}

/**
 * 文件拖出→系统下载的承接占位（INT-IM-25/D06）：
 * 拖出数据已就绪（file_id + 名称），票据 API（getDownloadTicket）已有；
 * WKWebView 内把拖放转系统落盘需 Tauri 侧接管 drag session——阶段一留 handler 占位，
 * D06 拖出下载接入后在此取票触发。
 */
function onFileDragOut(fileId: string): void {
  // TODO(D06)：getDownloadTicket(fileId) → 票据 URL 交系统侧下载
  void fileId;
}

/** 文件卡片（D06 阶段一真实化）：名/大小人性化(B/KB/MB)/ext 图标 + ⤓ 票据下载 + 拖出（INT-IM-25） */
function FileCard({ body }: { body: FileMessageBody }) {
  const [downloading, setDownloading] = useState(false);
  const doDownload = () => {
    if (downloading) return;
    setDownloading(true);
    // 票据 120s 一次性：取票即开（window.open 新窗直下；4014 由服务端 envelope 返回）
    void getDownloadTicket(body.file_id)
      .then((t) => {
        window.open(downloadUrl(t.url), '_blank');
      })
      .catch(() => undefined)
      .finally(() => setDownloading(false));
  };
  return (
    <div
      className="file-card file-card--draggable"
      data-testid="file-card"
      draggable
      title="点击 ⤓ 下载；可拖出到桌面/文件夹（拖出=下载）"
      onDragStart={(e) => {
        // 拖出（INT-IM-25）：dataTransfer 携带文件标识（自描述 JSON + 纯文本名兜底）
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(
          'application/x-bbw-file',
          JSON.stringify({ file_id: body.file_id, name: body.name ?? '', size: body.size ?? 0 }),
        );
        e.dataTransfer.setData('text/plain', body.name ?? body.file_id);
        onFileDragOut(body.file_id); // 下载承接占位（见上）
      }}
    >
      <div className="file-card__icon">
        <FileText size={20} />
      </div>
      <div className="file-card__meta">
        <div className="file-card__name" title={body.name}>
          {body.name ?? '未命名文件'}
        </div>
        <div className="file-card__hint">
          {body.size !== undefined ? formatBytes(body.size) : '—'}
          {body.ext ? ` · ${body.ext.toUpperCase()}` : ''}
        </div>
      </div>
      <button
        type="button"
        className="file-card__download"
        data-testid="file-card-download"
        title="下载"
        onClick={(e) => {
          e.stopPropagation();
          doDownload();
        }}
      >
        <ArrowDownToLine size={15} />
      </button>
    </div>
  );
}

/**
 * 视频卡片气泡（04 §1.2 第 8 类 video）：主视频票据拉流 + poster 票据封面，
 * 原生控件内联播放（preload=metadata）；时长角标；失败红态可重试。
 */
function VideoCard({ body }: { body: FileMessageBody }) {
  const [src, setSrc] = useState<string | null>(null);
  const [poster, setPoster] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const srcRef = useRef<string | null>(null);
  const posterRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    (async () => {
      try {
        const t = await getDownloadTicket(body.file_id);
        const resp = await fetch(downloadUrl(t.url));
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const blob = await resp.blob();
        if (!alive) return;
        const u = URL.createObjectURL(blob);
        srcRef.current = u;
        setSrc(u);
        if (body.poster_file_id) {
          try {
            const pt = await getDownloadTicket(body.poster_file_id);
            const pr = await fetch(downloadUrl(pt.url));
            if (pr.ok) {
              const pb = await pr.blob();
              if (alive) {
                const pu = URL.createObjectURL(pb);
                posterRef.current = pu;
                setPoster(pu);
              }
            }
          } catch {
            /* poster 可缺省 */
          }
        }
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (srcRef.current) URL.revokeObjectURL(srcRef.current);
      if (posterRef.current) URL.revokeObjectURL(posterRef.current);
      srcRef.current = null;
      posterRef.current = null;
    };
  }, [body.file_id, body.poster_file_id]);

  if (failed) {
    return (
      <div className="msg-image msg-image--error" data-testid="video-error">
        <Video size={16} />
        <span>视频加载失败</span>
      </div>
    );
  }
  return (
    <div className="msg-video-card" data-testid="msg-video-card">
      {src ? (
        <video
          className="msg-video"
          src={src}
          poster={poster ?? undefined}
          controls
          preload="metadata"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="msg-video msg-video--loading" />
      )}
      {body.duration_ms ? <span className="msg-video__dur">{Math.round(body.duration_ms / 1000)}s</span> : null}
    </div>
  );
}

/**
 * 表情包气泡（0022 sticker）：票据 → blob → objectURL 大图渲染（≤120px 等比，
 * 无气泡底，点击灯箱复用图片口径）；失败占位不阻塞布局。
 */
function StickerCard({ body }: { body: FileMessageBody }) {
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await getDownloadTicket(body.file_id);
        const resp = await fetch(downloadUrl(t.url));
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const blob = await resp.blob();
        if (!alive) return;
        const u = URL.createObjectURL(blob);
        urlRef.current = u;
        setObjUrl(u);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [body.file_id]);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  if (failed) {
    return (
      <div className="msg-image msg-image--error" data-testid="sticker-error">
        <ImageIcon size={16} />
        <span>表情加载失败</span>
      </div>
    );
  }
  return (
    <>
      {objUrl ? (
        <img
          className="msg-sticker"
          data-testid="msg-sticker"
          src={objUrl}
          alt="表情"
          title={body.name}
          onClick={(e) => {
            e.stopPropagation();
            setZoom(true);
          }}
        />
      ) : (
        <span className="msg-sticker msg-sticker--loading" />
      )}
      {zoom ? (
        <div className="image-lightbox" onClick={() => setZoom(false)}>
          <img className="image-lightbox__img" src={objUrl ?? ''} alt="表情" />
        </div>
      ) : null}
    </>
  );
}

/**
 * 语音条气泡（audio_clip）：票据 → blob → objectURL，<audio> 驱动自绘播放条
 * （播放/暂停 + 伪波纹 + 进度 + 时长；时长优先 body.duration_ms，音频元数据兜底）。
 * 加载失败红态可重试（票据一次性，同图片口径）。
 */
function AudioClipCard({ body, mine }: { body: FileMessageBody; mine: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0-1
  const [durSec, setDurSec] = useState(body.duration_ms ? Math.round(body.duration_ms / 1000) : 0);

  const load = useCallback(async (fileId: string) => {
    setFailed(false);
    try {
      const t = await getDownloadTicket(fileId);
      const resp = await fetch(downloadUrl(t.url));
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const blob = await resp.blob();
      const u = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = u;
      setObjUrl(u);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load(body.file_id);
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [load, body.file_id]);

  // 元数据兜底时长（录音端 duration_ms 缺失时）
  useEffect(() => {
    const a = audioRef.current;
    if (a && !body.duration_ms && a.duration && Number.isFinite(a.duration)) {
      setDurSec(Math.round(a.duration));
    }
  }, [objUrl, body.duration_ms]);

  if (failed) {
    return (
      <div className="msg-image msg-image--error" data-testid="voice-error">
        <Mic size={16} />
        <span>语音加载失败</span>
        <button type="button" className="msg-image__retry" onClick={() => void load(body.file_id)}>
          重试
        </button>
      </div>
    );
  }

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play();
    } else {
      a.pause();
    }
  };

  const label = body.duration_ms ? `${Math.round(body.duration_ms / 1000)}″` : durSec ? `${durSec}″` : '…';

  return (
    <span className={`voice-msg${mine ? ' voice-msg--mine' : ''}`} data-testid="voice-msg">
      {objUrl ? (
        <audio
          ref={audioRef}
          src={objUrl}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            if (a.duration && Number.isFinite(a.duration)) setProgress(a.currentTime / a.duration);
          }}
        />
      ) : null}
      <button type="button" className="voice-msg__play" data-testid="voice-play" onClick={toggle} disabled={!objUrl}>
        {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
      <span className="voice-msg__wave" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} className={playing && progress * 5 > i ? ' voice-msg__bar--lit' : undefined} />
        ))}
      </span>
      <span className="voice-msg__dur">{label}</span>
    </span>
  );
}

/**
 * 图片气泡（D06 阶段一）：取一次性票据 → fetch blob → objectURL 渲染（票据一次性不可直接作 src 复用）；
 * 点击灯箱放大查看（三级预览只做原图+灯箱，服务端缩略不做——端内 CSS 渲染原图，登记）；
 * 4014/加载失败红态可重试。
 */
function ImageCard({ body }: { body: FileMessageBody }) {
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  const urlRef = useRef<string | null>(null);

  const load = useCallback(async (fileId: string) => {
    setFailed(false);
    try {
      const t = await getDownloadTicket(fileId);
      const resp = await fetch(downloadUrl(t.url));
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const blob = await resp.blob();
      const u = URL.createObjectURL(blob);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = u;
      setObjUrl(u);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load(body.file_id);
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [load, body.file_id]);

  // 灯箱 Esc 关闭
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  if (failed) {
    return (
      <div className="msg-image msg-image--error" data-testid="msg-image-error">
        <ImageIcon size={16} />
        <span>图片加载失败（票据可能已失效）</span>
        <button type="button" className="msg-image__retry" onClick={() => void load(body.file_id)}>
          重试
        </button>
      </div>
    );
  }
  if (!objUrl) {
    return (
      <div className="msg-image msg-image--loading" data-testid="msg-image-loading" title={body.name}>
        <span className="skeleton-block" />
      </div>
    );
  }
  return (
    <>
      <img
        className="msg-image"
        data-testid="msg-image"
        src={objUrl}
        alt={body.name ?? '图片'}
        title={body.name}
        onClick={(e) => {
          e.stopPropagation();
          setZoom(true);
        }}
      />
      {/* caption 随图说明（04 §1.2 第 5 类；渲染于缩略图下方） */}
      {body.caption ? <span className="msg-image__caption">{body.caption}</span> : null}
      {zoom ? (
        <div className="image-lightbox" data-testid="image-lightbox" onClick={() => setZoom(false)}>
          <img className="image-lightbox__img" src={objUrl} alt={body.name ?? '图片'} />
          <div className="image-lightbox__caption">
            {body.name} {body.width && body.height ? `${body.width}×${body.height}` : ''}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function MessageBubble({
  message,
  mine,
  onRetry,
  peerReadSeq = 0,
  actions,
  myUid,
  myRole,
  applyHandled,
  onApplyHandled,
  multiSelect,
  onSelectToggle,
  onOpenMsgMenu,
  onOpenReceipts,
}: MessageBubbleProps) {
  /** 完整表情选择器 popover（INT-IM-25：悬浮条「更多表情」真选择器，替换旧固定🎉） */
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  // popover 打开时点外部关闭（capture 阶段，按钮自身已 stopPropagation 不误触）
  useEffect(() => {
    if (!emojiPickerOpen) return;
    const close = () => setEmojiPickerOpen(false);
    document.addEventListener('click', close, true);
    return () => document.removeEventListener('click', close, true);
  }, [emojiPickerOpen]);
  // 右键/长按可开菜单判定（INT-IM-25 与悬浮条/菜单同源 msgActionsVisible）：
  // 撤回占位（status=2）无任何项不开；system 仅「复制」可开
  const canOpenMenu = !!onOpenMsgMenu && hasAnyMsgAction(msgActionsVisible(message, myUid));
  const openMenu = canOpenMenu && onOpenMsgMenu ? (at: MenuAnchor) => onOpenMsgMenu(message, at) : null;
  const longPress = useLongPressMenu(openMenu);
  /** 右键/长按挂接属性（不可开菜单的消息不带——撤回占位走浏览器原生行为） */
  const menuTriggerProps = openMenu
    ? {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY });
        },
        ...longPress,
      }
    : undefined;

  // 系统消息/撤回占位：居中弱化，不参与回执；system 可右键仅「复制」（PIM-12 + INT-IM-25）
  if (message.type === 'system') {
    // 服务端下发的占位消息：按 body.kind 套注册表模板（systemMessageRegistry）
    if ('kind' in message.body && message.body.kind) {
      const body = message.body as SystemBody;
      if (body.kind === 'apply.submitted' && body.apply_id && onApplyHandled) {
        // 审批卡（PIM-06）：owner/admin 可见按钮，member 只读
        return (
          <div className="msg-system msg-system--card" {...menuTriggerProps}>
            <ApplyCard
              body={body}
              submittedAt={message.ts}
              myRole={myRole}
              handled={applyHandled}
              onHandled={onApplyHandled}
            />
          </div>
        );
      }
      return (
        <div className="msg-system" data-testid="msg-system" {...menuTriggerProps}>
          {systemMessageText(body)}
        </div>
      );
    }
    // 撤回占位等本地生成的 system 形态（body={text}）——status=2 时 canOpenMenu 已为 false
    const text = 'text' in message.body ? message.body.text : '群通知';
    return (
      <div className="msg-system" data-testid="msg-system" {...menuTriggerProps}>
        {text}
      </div>
    );
  }
  // 历史拉取路径的已撤回消息（服务端真值 status=2，type 仍为原文案类型）：
  // 与实时 msg.recall 推送同款占位（实时路径由 store 转 system 形态，此处兜底）；无菜单
  if (message.status === 2) {
    return (
      <div className="msg-system">
        {mine ? '你撤回了一条消息' : `${message.senderName} 撤回了一条消息`}
      </div>
    );
  }

  const isText = message.type === 'text';
  const isMerge = message.type === 'merge_forward';
  const isImage = message.type === 'image';
  const isFile = message.type === 'file';
  // 语音条（audio_clip：body 同 file 形态 + duration_ms）
  const isAudio = message.type === 'audio_clip';
  const audioBody = isAudio && 'file_id' in message.body ? (message.body as FileMessageBody) : null;
  // 表情包（0022 sticker：body {sticker_id,file_id}）
  const isSticker = message.type === 'sticker';
  const stickerBody = isSticker && 'file_id' in message.body ? (message.body as FileMessageBody) : null;
  // 视频卡片（04 §1.2 第 8 类：body {file_id,poster_file_id,duration_ms,...}）
  const isVideo = message.type === 'video';
  const videoBody = isVideo && 'file_id' in message.body ? (message.body as FileMessageBody) : null;
  // 通话卡片（D04 §4.5 call_card：方向/状态/时长/再次呼叫；组件在 shared，回拨经 bus 转发 rtc）
  const isCallCard = message.type === 'call_card';
  const callBody = isCallCard && 'call_id' in message.body ? (message.body as CallCardBody) : null;
  // file/image body 窄化（D06：{file_id,...}；服务端透传）
  const fileBody = (isImage || isFile) && 'file_id' in message.body ? (message.body as FileMessageBody) : null;
  // 编辑/撤回显隐不再在此判——悬浮条瘦身（快捷 emoji+回复+⋯），条件项全部移入
  // 统一右键菜单，与菜单共用 msgActionsVisible（INT-IM-25）
  const text = isText && 'text' in message.body ? message.body.text : '';

  /** 回应切换：add/remove 由调用方按 ext.reactions 现态判定（全量快照回收保证一致） */
  const doReact = (emoji: string) => actions?.onReact(message, emoji);

  // 多选模式（INT-IM-14）：整行可点切换勾选；气泡内容经 CSS pointer-events:none 收敛交互
  const selecting = multiSelect?.active === true;
  const selected = multiSelect?.selected === true;
  const doToggle = () => onSelectToggle?.(message);

  return (
    <div
      className={`msg-row${mine ? ' msg-row--mine' : ''}${selecting ? ' msg-row--selecting' : ''}${selected ? ' msg-row--selected' : ''}`}
      data-seq={message.seq}
      data-testid="msg-row"
      onClick={selecting ? doToggle : undefined}
      {...menuTriggerProps}
    >
      {/* 多选复选框浮层（system/撤回占位已在上方早退，不参与多选） */}
      {selecting ? (
        <button
          type="button"
          className={`msg-check${selected ? ' msg-check--on' : ''}`}
          data-testid="msg-check"
          aria-pressed={selected}
          title={selected ? '取消选择' : '选择'}
          onClick={(e) => {
            e.stopPropagation();
            doToggle();
          }}
        >
          {selected ? <Check size={12} /> : null}
        </button>
      ) : null}
      <Avatar name={message.senderName} size={32} />
      <div className="msg-row__body">
        {mine ? null : <span className="msg-row__sender">{message.senderName}</span>}
        <div className="msg-row__bubble-wrap">
          {isText ? (
            <span className={`bubble ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <ReplyQuote message={message} onLocate={actions?.onLocate} />
              <TextWithMentions text={text} mentions={message.mentions} />
              {message.status === 3 ? <span className="msg-edited-tag">已编辑</span> : null}
            </span>
          ) : isMerge ? (
            <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <MergeForwardCard message={message} onOpen={actions?.onOpenMergeDetail} />
            </span>
          ) : isImage && fileBody ? (
            <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <ImageCard body={fileBody} />
            </span>
          ) : isFile && fileBody ? (
            <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <FileCard body={fileBody} />
            </span>
          ) : isAudio && audioBody ? (
            <AudioClipCard body={audioBody} mine={mine} />
          ) : isSticker && stickerBody ? (
            <StickerCard body={stickerBody} />
          ) : isVideo && videoBody ? (
            <VideoCard body={videoBody} />
          ) : isCallCard && callBody ? (
            <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <CallCard
                body={callBody}
                mine={mine}
                onRecall={(video) => emit('im:invoke-call', { convId: message.convId, video })}
                onJoin={() => emit('rtc:join-call', { callId: callBody.call_id, convId: message.convId, video: callBody.call_type === 'video' })}
              />
            </span>
          ) : (
            <span className={`bubble bubble--card ${mine ? 'bubble--mine' : 'bubble--peer'}`}>
              <div className="file-card">
                <div className="file-card__icon">
                  <FileText size={20} />
                </div>
                <div className="file-card__meta">
                  <div className="file-card__name">{'name' in message.body && message.body.name ? message.body.name : digestOf(message)}</div>
                  <div className="file-card__hint">附件 · 查看器后续接入（D06）</div>
                </div>
              </div>
            </span>
          )}

          {/* 悬浮操作条（瘦身，INT-IM-25）：快捷 emoji + 回复 + ⋯（开统一菜单；
              编辑/撤回/转发/收藏/多选移入菜单，减少重复入口——快捷表情区无菜单语义，保留原样） */}
          {actions ? (
            <div className="msg-actions">
              {QUICK_EMOJIS.slice(0, 3).map((e) => (
                <button
                  key={e}
                  type="button"
                  className="msg-actions__emoji"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    doReact(e);
                  }}
                >
                  {e}
                </button>
              ))}
              <button
                type="button"
                className="msg-actions__btn"
                title="更多表情"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setEmojiPickerOpen((v) => !v);
                }}
              >
                <SmilePlus size={14} />
              </button>
              {emojiPickerOpen ? (
                <div className="msg-emoji-popover">
                  <EmojiPicker
                    onPick={(e) => {
                      doReact(e);
                      setEmojiPickerOpen(false);
                    }}
                  />
                </div>
              ) : null}
              <button type="button" className="msg-actions__btn" title="回复" onClick={() => actions.onReply(message)}>
                回复
              </button>
              {/* ⋯ 打开统一右键菜单（锚定按钮左下角；菜单内动作复用同一套 handlers） */}
              {onOpenMsgMenu ? (
                <button
                  type="button"
                  className="msg-actions__btn"
                  data-testid="msg-more-btn"
                  title="更多操作（右键消息同款菜单）"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                    onOpenMsgMenu(message, { x: r.left, y: r.bottom + 4 });
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <ReactionBar message={message} myUid={myUid} onReact={(e) => doReact(e)} />
        {mine ? <StateTag message={message} onRetry={onRetry} peerReadSeq={peerReadSeq} onOpenReceipts={onOpenReceipts} /> : null}
      </div>
    </div>
  );
}
