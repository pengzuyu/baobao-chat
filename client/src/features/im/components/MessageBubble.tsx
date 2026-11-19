/**
 * 消息气泡族（D03 §3.2；D26-O7 全量 antd 换装）：
 * - text：己方 var(--bbc-bubble-self) / 对方 var(--bbc-bubble-peer)，圆角 12 带 4 尾巴
 *   （壳体内联 + theme.useToken 取色；自研 msg-bubble 族样式退役）
 * - 图片/表情灯箱 → antd Image preview（缩放/旋转/下载工具条免费获得；原图
 *   票据仍按需懒加载——preview 打开才取 origin，失败回落缩略）
 * - 引用条：reply_to_seq + ext.reply_digest 快照，点击定位原消息（INT-IM-04）
 * - 表情回应条：ext.reactions 全量快照渲染，Tag 化，点击增删本人（INT-IM-23）
 * - 已编辑角标 / 撤回占位（store 已转 system 形态）/ merge_forward 卡片
 * - @提及高亮：mentions.range 内文本主色+底纹（INT-IM-24）
 * - 悬浮操作条（瘦身，INT-IM-25）：快捷 emoji + 回复 + ⋯（打开统一右键菜单）；
 *   更多表情走 antd Popover；hover 显隐改 React hover 态（原 CSS :hover 退役）
 * - 右键/长按 500ms 打开统一菜单（system 仅复制、撤回占位无菜单——hasAnyMsgAction 判定）
 * - 文件卡片可拖出（draggable → dataTransfer 文件 id，拖到系统=下载票据触发，D06 承接）
 * - 本地态尾标：sending 灰钟 → sent ✓ → 对方已读 ✓✓（msg.receipt，04 篇 §4.2）；
 *   failed 红叹号（点击重试，INT-IM-01a）
 * - 行级锚点保真：data-seq（ChatPage 定位闪烁 querySelector）与全部 data-testid 原样保留
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Flex, Image, Popover, Tag, Typography, theme } from 'antd';
import { useAgentStore } from '../../agent/store/agent';
import { getAgentBridge } from '../../agent/bridge';
import { currentRoundItems, roundQuestionOf, stagesFromStream } from '../agent/embedded';
import {
  AlertCircle,
  ArrowDownToLine,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  Clock3,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  ListOrdered,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  SmilePlus,
  Video,
} from 'lucide-react';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { AgentProcessCard, agentStatsText, type AgentCardBody } from '../../../shared/components/AgentProcessCard';
import { getErrorText } from '../../../shared/api/http';
import { formatBytes } from '../../../shared/utils/format';
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

const { Text } = Typography;

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
  const { token } = theme.useToken();
  if (!message.localState) return null;
  if (message.localState === 'sending')
    return (
      <span title="发送中" style={{ fontSize: 12, color: token.colorTextTertiary, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
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
        <Button
          variant="text"
          size="small"
          title={title}
          data-testid="receipt-tag"
          style={{ padding: 0, height: 'auto', fontSize: 12, color: token.colorTextTertiary }}
          onClick={(e) => {
            e.stopPropagation();
            onOpenReceipts(message);
          }}
        >
          {icon}
        </Button>
      );
    }
    return (
      <span title={title} style={{ fontSize: 12, color: token.colorTextTertiary, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {icon}
      </span>
    );
  }
  return (
    <Button
      variant="text"
      danger
      size="small"
      title={getErrorText(3007)}
      style={{ padding: 0, height: 'auto', fontSize: 12 }}
      onClick={(e) => {
        e.stopPropagation();
        onRetry(message.clientMsgId);
      }}
    >
      <AlertCircle size={14} />
      <RotateCcw size={12} />
      重试
    </Button>
  );
}

/** @提及高亮渲染：mentions.range（INT-IM-24） */
function TextWithMentions({ text, mentions }: { text: string; mentions?: Mention[] }) {
  const { token } = theme.useToken();
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
          <span
            key={i}
            style={{ color: token.colorPrimary, background: 'var(--bbc-primary-light)', borderRadius: 3, padding: '0 2px' }}
          >
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
  const { token } = theme.useToken();
  const d = message.ext?.reply_digest;
  if (!d) return null;
  return (
    <div
      onClick={() => onLocate?.(d.seq)}
      role="button"
      tabIndex={0}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        background: 'var(--bbc-quote-bg)',
        borderLeft: `3px solid ${token.colorPrimary}`,
        borderRadius: 4,
        padding: '4px 8px',
        marginBottom: 4,
        cursor: 'pointer',
        maxWidth: 360,
      }}
    >
      <Text style={{ fontSize: 12, color: token.colorPrimary, fontWeight: 500 }}>{d.sender_name || d.sender_id}</Text>
      <span
        style={{
          fontSize: 12,
          color: token.colorTextSecondary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {d.digest}
      </span>
    </div>
  );
}

/** 表情回应条（INT-IM-23：不占 seq/不计未读；Tag 化，点击切换本人增删） */
function ReactionBar({ message, myUid, onReact }: { message: Message; myUid: string; onReact?: (emoji: string) => void }) {
  const { token } = theme.useToken();
  const reactions = message.ext?.reactions;
  if (!reactions || Object.keys(reactions).length === 0) return null;
  return (
    <Flex gap={4} wrap style={{ marginTop: 4 }}>
      {Object.entries(reactions).map(([emoji, uids]) => {
        const mine = uids.includes(myUid);
        return (
          <Tag
            key={emoji}
            title={uids.join('、')}
            onClick={(e) => {
              e.stopPropagation();
              onReact?.(emoji);
            }}
            style={{
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              marginInlineEnd: 0,
              padding: '1px 7px',
              borderRadius: 10,
              fontSize: 13,
              lineHeight: 1.5,
              userSelect: 'none',
              ...(mine
                ? { color: token.colorPrimary, background: 'var(--bbc-primary-light)', borderColor: token.colorPrimary }
                : { color: token.colorText, background: token.colorBgContainer, borderColor: token.colorBorderSecondary }),
            }}
          >
            <span>{emoji}</span>
            {uids.length > 1 ? <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{uids.length}</span> : null}
          </Tag>
        );
      })}
    </Flex>
  );
}

/** 合并转发卡片（PIM-10/PIM-11，D03 §3.2）：标题+count+前 3 条 digest 预览，点击 → PIM-11 抽屉 */
function MergeForwardCard({ message, onOpen }: { message: Message; onOpen?: (m: Message) => void }) {
  const { token } = theme.useToken();
  const b = 'items' in message.body ? (message.body as MergeForwardBody) : {};
  const items = b.items ?? [];
  const preview = items.slice(0, 3);
  return (
    <div
      data-testid="merge-forward-card"
      role="button"
      tabIndex={0}
      title="点击查看合并转发详情"
      style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180, cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(message);
      }}
      onKeyDown={(e) => e.key === 'Enter' && onOpen?.(message)}
    >
      <Flex align="center" gap={5} style={{ fontWeight: 500, fontSize: 13 }}>
        <ListOrdered size={14} />
        {b.title ?? '聊天记录'} · {b.count ?? items.length} 条消息
      </Flex>
      {preview.map((it, i) => (
        <Flex key={i} align="center" gap={6} style={{ minWidth: 0 }}>
          <span style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }}>{it.sender_name || it.sender_id}</span>
          <Flex align="center" gap={3} style={{ minWidth: 0, fontSize: 13, overflow: 'hidden' }}>
            {mergeTypeIcon(it.type)}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.digest}</span>
          </Flex>
        </Flex>
      ))}
      <Text type="secondary" style={{ fontSize: 12 }}>
        {items.length > 3 ? `共 ${items.length} 条，` : ''}点击查看详情
      </Text>
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
  const { token } = theme.useToken();
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
      data-testid="file-card"
      draggable
      title="点击 ⤓ 下载；可拖出到桌面/文件夹（拖出=下载）"
      style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 200, padding: '4px 8px', cursor: 'grab' }}
      onDragStart={(e) => {
        // 拖出（INT-IM-25）：dataTransfer 携带文件标识（自描述 JSON + 纯文本名兜底）
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(
          'application/x-bbc-file',
          JSON.stringify({ file_id: body.file_id, name: body.name ?? '', size: body.size ?? 0 }),
        );
        e.dataTransfer.setData('text/plain', body.name ?? body.file_id);
        onFileDragOut(body.file_id); // 下载承接占位（见上）
      }}
    >
      <Flex
        align="center"
        justify="center"
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: token.borderRadius,
          background: 'var(--bbc-primary-light)',
          color: token.colorPrimary,
        }}
      >
        <FileText size={20} />
      </Flex>
      <div style={{ minWidth: 0 }}>
        <div
          title={body.name}
          style={{ fontSize: 13, color: token.colorText, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {body.name ?? '未命名文件'}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {body.size !== undefined ? formatBytes(body.size) : '—'}
          {body.ext ? ` · ${body.ext.toUpperCase()}` : ''}
        </Text>
      </div>
      <Button
        variant="text"
        size="small"
        data-testid="file-card-download"
        title="下载"
        style={{ marginInlineStart: 'auto', color: token.colorTextSecondary }}
        icon={<ArrowDownToLine size={15} />}
        onClick={(e) => {
          e.stopPropagation();
          doDownload();
        }}
      />
    </div>
  );
}

/**
 * 视频卡片气泡（04 §1.2 第 8 类 video）：主视频票据拉流 + poster 票据封面，
 * 原生控件内联播放（preload=metadata）；时长角标；失败红态可重试。
 */
function VideoCard({ body }: { body: FileMessageBody }) {
  const { token } = theme.useToken();
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
      <Flex
        align="center"
        gap={6}
        data-testid="video-error"
        style={{ padding: '8px 12px', fontSize: 12, color: token.colorError, background: token.colorFillQuaternary, borderRadius: 12 }}
      >
        <Video size={16} />
        <span>视频加载失败</span>
      </Flex>
    );
  }
  return (
    <div data-testid="msg-video-card" style={{ position: 'relative', display: 'inline-block', maxWidth: 280 }}>
      {src ? (
        <video
          src={src}
          poster={poster ?? undefined}
          controls
          preload="metadata"
          style={{ display: 'block', width: 280, maxHeight: 320, borderRadius: 12, background: '#000' }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span style={{ display: 'block', width: 240, height: 160, background: token.colorBgLayout }} />
      )}
      {body.duration_ms ? (
        <span
          style={{
            position: 'absolute',
            right: 8,
            bottom: 28,
            padding: '1px 6px',
            borderRadius: 4,
            background: 'rgba(0, 0, 0, 0.55)',
            color: '#fff',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {Math.round(body.duration_ms / 1000)}s
        </span>
      ) : null}
    </div>
  );
}

/**
 * 表情包气泡（0022 sticker）：票据 → blob → objectURL 大图渲染（≤120px 等比，
 * 无气泡底，点击 antd Image preview 放大）；失败占位不阻塞布局。
 */
function StickerCard({ body }: { body: FileMessageBody }) {
  const { token } = theme.useToken();
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);

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

  if (failed) {
    return (
      <Flex
        align="center"
        gap={6}
        data-testid="sticker-error"
        style={{ padding: '8px 12px', fontSize: 12, color: token.colorError, background: token.colorFillQuaternary, borderRadius: 12 }}
      >
        <ImageIcon size={16} />
        <span>表情加载失败</span>
      </Flex>
    );
  }
  return objUrl ? (
    // 包裹层拦冒泡：预览点击不透传到消息行（多选行点击切换）
    <span onClick={(e) => e.stopPropagation()} style={{ lineHeight: 0 }}>
      <Image
        data-testid="msg-sticker"
        src={objUrl}
        alt="表情"
        title={body.name}
        style={{ maxWidth: 120, maxHeight: 120, borderRadius: 8, objectFit: 'contain' }}
        preview={{ src: objUrl, rootClassName: 'bbc-image-lightbox' }}
      />
    </span>
  ) : (
    <span style={{ display: 'block', width: 96, height: 96, background: token.colorBgLayout }} />
  );
}

/**
 * 语音条气泡（audio_clip）：票据 → blob → objectURL，<audio> 驱动自绘播放条
 * （播放/暂停 + 伪波纹 + 进度 + 时长；时长优先 body.duration_ms，音频元数据兜底）。
 * 加载失败红态可重试（票据一次性，同图片口径）。
 */
function AudioClipCard({ body, mine }: { body: FileMessageBody; mine: boolean }) {
  const { token } = theme.useToken();
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
      <Flex
        align="center"
        gap={6}
        data-testid="voice-error"
        style={{ padding: '8px 12px', fontSize: 12, color: token.colorError, background: token.colorFillQuaternary, borderRadius: 12 }}
      >
        <Mic size={16} />
        <span>语音加载失败</span>
        <Button variant="text" danger size="small" style={{ padding: '0 4px', height: 'auto', fontSize: 12 }} onClick={() => void load(body.file_id)}>
          重试
        </Button>
      </Flex>
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
  const barHeights = [8, 14, 20, 14, 8];

  return (
    <span
      data-testid="voice-msg"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 260,
        minWidth: 150,
        padding: '8px 12px',
        borderRadius: 12,
        background: mine ? 'var(--bbc-bubble-self)' : 'var(--bbc-bubble-peer)',
      }}
    >
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
      <Button
        variant="primary"
        size="small"
        data-testid="voice-play"
        style={{ flex: 'none', width: 24, height: 24, minWidth: 24, padding: 0, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        icon={playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        onClick={toggle}
        disabled={!objUrl}
      />
      {/* 伪波纹（内联进度条）：lit 段随播放进度点亮 */}
      <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: 1 }}>
        {barHeights.map((h, i) => (
          <i
            key={i}
            style={{
              width: 2,
              height: h,
              borderRadius: 1,
              display: 'inline-block',
              background: playing && progress * 5 > i ? token.colorPrimary : token.colorTextQuaternary,
            }}
          />
        ))}
      </span>
      <span style={{ fontSize: 12, color: token.colorTextSecondary, fontVariantNumeric: 'tabular-nums' }}>{label}</span>
    </span>
  );
}

/**
 * 图片气泡（D06+D25）：气泡取 240 缩略变体票据（服务端惰性生成、无变体自动回退
 * 原图——首屏先糊后清）；点击 antd Image preview 灯箱（缩放/旋转/下载工具条），
 * preview 打开才懒取 origin 票据（失败静默回落缩略）；4014/加载失败红态可重试。
 */
function ImageCard({ body }: { body: FileMessageBody }) {
  const { token } = theme.useToken();
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [originUrl, setOriginUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  const urlRef = useRef<string | null>(null);
  const originRef = useRef<string | null>(null);

  const load = useCallback(async (fileId: string) => {
    setFailed(false);
    try {
      const t = await getDownloadTicket(fileId, '240');
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
      if (originRef.current) URL.revokeObjectURL(originRef.current);
      urlRef.current = null;
      originRef.current = null;
    };
  }, [load, body.file_id]);

  // 灯箱原图懒加载（preview 打开才取 origin 票据；失败静默用缩略）
  useEffect(() => {
    if (!zoom || originUrl) return;
    let alive = true;
    (async () => {
      try {
        const t = await getDownloadTicket(body.file_id, 'origin');
        const resp = await fetch(downloadUrl(t.url));
        if (!resp.ok) return;
        const blob = await resp.blob();
        if (!alive) return;
        const u = URL.createObjectURL(blob);
        originRef.current = u;
        setOriginUrl(u);
      } catch {
        /* 原图取失败：灯箱继续展示缩略 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [zoom, originUrl, body.file_id]);

  if (failed) {
    return (
      <Flex
        align="center"
        gap={6}
        data-testid="msg-image-error"
        style={{ padding: '8px 12px', fontSize: 12, color: token.colorError, background: token.colorFillQuaternary, borderRadius: 12 }}
      >
        <ImageIcon size={16} />
        <span>图片加载失败（票据可能已失效）</span>
        <Button variant="text" danger size="small" style={{ padding: '0 4px', height: 'auto', fontSize: 12 }} onClick={() => void load(body.file_id)}>
          重试
        </Button>
      </Flex>
    );
  }
  if (!objUrl) {
    return (
      <div data-testid="msg-image-loading" title={body.name} style={{ width: 180, height: 130, background: token.colorBgLayout, borderRadius: 12 }} />
    );
  }
  return (
    <>
      {/* 包裹层拦冒泡：预览点击不透传到消息行（多选行点击切换） */}
      <span onClick={(e) => e.stopPropagation()} style={{ lineHeight: 0 }}>
        <Image
          data-testid="msg-image"
          src={objUrl}
          alt={body.name ?? '图片'}
          title={body.name}
          /* 预留宽高（2026-11-11）：blob 加载前浏览器即可按比例占位——首屏跳底后
           * 图片加载不再撑高把视口顶离最新消息（maxWidth/maxHeight + object-fit 截幅） */
          width={body.width || undefined}
          height={body.height || undefined}
          style={{ maxWidth: 240, maxHeight: 320, objectFit: 'contain', borderRadius: 12 }}
          preview={{
            visible: zoom,
            onVisibleChange: (v) => setZoom(v),
            src: originUrl ?? objUrl,
            rootClassName: 'bbc-image-lightbox',
          }}
        />
      </span>
      {/* caption 随图说明（04 §1.2 第 5 类；渲染于缩略图下方） */}
      {body.caption ? (
        <span
          style={{
            display: 'block',
            maxWidth: 240,
            marginTop: 4,
            padding: '6px 10px',
            borderRadius: 12,
            background: 'var(--bbc-gray-2)',
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {body.caption}
        </span>
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
  const { token } = theme.useToken();
  /** 完整表情选择器 popover（INT-IM-25：悬浮条「更多表情」真选择器，antd Popover 承载） */
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  /** 悬浮操作条显隐（原 CSS :hover 退役）：行 hover 或 popover 打开时可见 */
  const [hovered, setHovered] = useState(false);
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
          <div style={{ alignSelf: 'center' }} {...menuTriggerProps}>
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
        <div
          data-testid="msg-system"
          style={{ alignSelf: 'center', color: 'var(--bbc-system-msg)', fontSize: 12, padding: '8px 0' }}
          {...menuTriggerProps}
        >
          {systemMessageText(body)}
        </div>
      );
    }
    // 撤回占位等本地生成的 system 形态（body={text}）——status=2 时 canOpenMenu 已为 false
    const text = 'text' in message.body ? message.body.text : '群通知';
    return (
      <div
        data-testid="msg-system"
        style={{ alignSelf: 'center', color: 'var(--bbc-system-msg)', fontSize: 12, padding: '8px 0' }}
        {...menuTriggerProps}
      >
        {text}
      </div>
    );
  }
  // 历史拉取路径的已撤回消息（服务端真值 status=2，type 仍为原文案类型）：
  // 与实时 msg.recall 推送同款占位（实时路径由 store 转 system 形态，此处兜底）；无菜单
  if (message.status === 2) {
    return (
      <div style={{ alignSelf: 'center', color: 'var(--bbc-system-msg)', fontSize: 12, padding: '8px 0' }}>
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
  // file/image body 窄化（D06：{file_id,...}；服务端透传）
  const fileBody = (isImage || isFile) && 'file_id' in message.body ? (message.body as FileMessageBody) : null;
  // 编辑/撤回显隐不再在此判——悬浮条瘦身（快捷 emoji+回复+⋯），条件项全部移入
  // 统一右键菜单，与菜单共用 msgActionsVisible（INT-IM-25）
  const text = isText && 'text' in message.body ? message.body.text : '';

  /** agent_card 体窄化（D18 §4.1：kind=embedded_agent 才渲染过程卡；未知 kind 走兜底附件卡） */
function isAgentCardBody(b: unknown): b is AgentCardBody {
  return typeof b === 'object' && b !== null && (b as { kind?: string }).kind === 'embedded_agent' && Array.isArray((b as { stages?: unknown }).stages);
}

/** 回应切换：add/remove 由调用方按 ext.reactions 现态判定（全量快照回收保证一致） */
  const doReact = (emoji: string) => actions?.onReact(message, emoji);

  // 多选模式（INT-IM-14）：整行可点切换勾选；气泡内容经 pointerEvents:none 收敛交互
  const selecting = multiSelect?.active === true;
  const selected = multiSelect?.selected === true;
  const doToggle = () => onSelectToggle?.(message);

  /** 气泡壳内联样式（己方/对方灰阶气泡；卡片型同底、内边距收紧） */
  const bubbleStyle = (card: boolean): React.CSSProperties => ({
    display: 'inline-block',
    padding: card ? 4 : '8px 12px',
    borderRadius: 12,
    background: mine ? 'var(--bbc-bubble-self)' : 'var(--bbc-bubble-peer)',
    ...(mine ? { borderTopRightRadius: 4 } : { borderTopLeftRadius: 4 }),
  });

  return (
    <div
      data-seq={message.seq}
      data-testid="msg-row"
      style={{
        display: 'flex',
        gap: 8,
        maxWidth: '86%',
        ...(mine ? { alignSelf: 'flex-end', flexDirection: 'row-reverse' } : undefined),
        ...(selecting
          ? {
              cursor: 'pointer',
              borderRadius: 8,
              background: selected ? 'var(--bbc-primary-light)' : hovered ? token.colorFillQuaternary : undefined,
            }
          : undefined),
      }}
      onClick={selecting ? doToggle : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...menuTriggerProps}
    >
      {/* 多选复选框浮层（system/撤回占位已在上方早退，不参与多选；
          mine 行 row-reverse 下 order 10 保持视觉左侧） */}
      {selecting ? (
        <Button
          variant="text"
          size="small"
          data-testid="msg-check"
          aria-pressed={selected}
          title={selected ? '取消选择' : '选择'}
          style={{
            flexShrink: 0,
            alignSelf: 'flex-start',
            marginTop: 7,
            width: 18,
            height: 18,
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 5,
            border: `1.5px solid ${selected ? token.colorPrimary : token.colorTextQuaternary}`,
            background: selected ? token.colorPrimary : token.colorBgContainer,
            color: '#fff',
            ...(mine ? { order: 10 } : undefined),
          }}
          onClick={(e) => {
            e.stopPropagation();
            doToggle();
          }}
        >
          {selected ? <Check size={12} /> : null}
        </Button>
      ) : null}
      <Avatar name={message.senderName} size={32} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {/* agent_card 恒左对齐（2026-11-11）：本人发起的卡不显示发送者名（回答主体是
         * Agent，卡头已标识）；他人卡保留名字（群聊归属有意义） */}
        {mine || (message.type === 'agent_card' && message.senderId === myUid) ? null : (
          <Text style={{ fontSize: 12, color: token.colorTextTertiary, textAlign: mine ? 'right' : undefined }}>
            {message.senderName}
          </Text>
        )}
        <div
          style={{
            position: 'relative',
            display: 'inline-flex',
            flexDirection: 'column',
            maxWidth: '100%',
            ...(selecting ? { pointerEvents: 'none' } : undefined),
          }}
        >
          {isText ? (
            <span style={{ ...bubbleStyle(false), fontSize: token.fontSize, color: token.colorText, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
              <ReplyQuote message={message} onLocate={actions?.onLocate} />
              <Text>
                <TextWithMentions text={text} mentions={message.mentions} />
              </Text>
              {message.status === 3 ? (
                <Text style={{ fontSize: 10, color: token.colorTextQuaternary, marginInlineStart: 6 }}>
                  已编辑
                </Text>
              ) : null}
            </span>
          ) : isMerge ? (
            <span style={bubbleStyle(true)}>
              <MergeForwardCard message={message} onOpen={actions?.onOpenMergeDetail} />
            </span>
          ) : isImage && fileBody ? (
            <span style={bubbleStyle(true)}>
              <ImageCard body={fileBody} />
            </span>
          ) : isFile && fileBody ? (
            <span style={bubbleStyle(true)}>
              <FileCard body={fileBody} />
            </span>
          ) : isAudio && audioBody ? (
            <AudioClipCard body={audioBody} mine={mine} />
          ) : isSticker && stickerBody ? (
            <StickerCard body={stickerBody} />
          ) : isVideo && videoBody ? (
            <VideoCard body={videoBody} />
          ) : message.type === 'agent_card' && isAgentCardBody(message.body) ? (
            <span style={bubbleStyle(true)}>
              <AgentCardMsg body={message.body as AgentCardBody} />
            </span>
          ) : (
            <span style={bubbleStyle(true)}>
              <FileCardFallback name={'name' in message.body && message.body.name ? message.body.name : digestOf(message)} />
            </span>
          )}

          {/* 悬浮操作条（瘦身，INT-IM-25）：快捷 emoji + 回复 + ⋯（开统一菜单；
              编辑/撤回/转发/收藏/多选移入菜单，减少重复入口——快捷表情区无菜单语义，保留原样） */}
          {actions && !selecting && (hovered || emojiPickerOpen) ? (
            <Flex
              align="center"
              gap={2}
              style={{
                position: 'absolute',
                top: -22,
                right: 4,
                padding: '2px 4px',
                background: token.colorBgContainer,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 8,
                boxShadow: token.boxShadowSecondary,
                zIndex: 5,
              }}
            >
              {QUICK_EMOJIS.slice(0, 3).map((e) => (
                <Button
                  key={e}
                  variant="text"
                  size="small"
                  style={{ fontSize: 14, padding: '2px 3px', height: 'auto', lineHeight: 1 }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    doReact(e);
                  }}
                >
                  {e}
                </Button>
              ))}
              <Popover
                open={emojiPickerOpen}
                onOpenChange={setEmojiPickerOpen}
                trigger="click"
                placement="topRight"
                content={
                  <EmojiPicker
                    onPick={(e) => {
                      doReact(e);
                      setEmojiPickerOpen(false);
                    }}
                  />
                }
              >
                <Button
                  variant="text"
                  size="small"
                  title="更多表情"
                  style={{ padding: 2, height: 'auto' }}
                  icon={<SmilePlus size={14} />}
                  onClick={(ev) => ev.stopPropagation()}
                />
              </Popover>
              <Button
                variant="text"
                size="small"
                title="回复"
                style={{ fontSize: 12, color: token.colorTextSecondary }}
                onClick={() => actions.onReply(message)}
              >
                回复
              </Button>
              {/* ⋯ 打开统一右键菜单（锚定按钮左下角；菜单内动作复用同一套 handlers） */}
              {onOpenMsgMenu ? (
                <Button
                  variant="text"
                  size="small"
                  data-testid="msg-more-btn"
                  title="更多操作（右键消息同款菜单）"
                  style={{ padding: 2, height: 'auto' }}
                  icon={<MoreHorizontal size={14} />}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                    onOpenMsgMenu(message, { x: r.left, y: r.bottom + 4 });
                  }}
                />
              ) : null}
            </Flex>
          ) : null}
        </div>
        <ReactionBar message={message} myUid={myUid} onReact={(e) => doReact(e)} />
        {mine ? <StateTag message={message} onRetry={onRetry} peerReadSeq={peerReadSeq} onOpenReceipts={onOpenReceipts} /> : null}
      </div>
    </div>
  );
}

/** 兜底附件卡（未知消息类型）：名 + 提示（D06 查看器接入前） */
function FileCardFallback({ name }: { name: string }) {
  const { token } = theme.useToken();
  return (
    <Flex align="center" gap={12} style={{ minWidth: 200, padding: '4px 8px' }}>
      <Flex
        align="center"
        justify="center"
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: token.borderRadius,
          background: 'var(--bbc-primary-light)',
          color: token.colorPrimary,
        }}
      >
        <FileText size={20} />
      </Flex>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: token.colorText, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          附件 · 查看器后续接入（D06）
        </Text>
      </div>
    </Flex>
  );
}

/** Agent 会话运行态集合（落流卡 live 判定；与工作台 TURN_ACTIVE_STATUSES 同口径） */
const AGENT_LIVE_STATUSES = new Set<string>([
  'running',
  'waiting_permission',
  'waiting_clarify',
  'subagent_fanout',
]);

/** 落流卡完成后保持展开的宽限（2026-11-11 用户口径）：到点后台自动折叠成摘要卡
 * （无倒计时 UI）；期间用户再向 agent 发消息=新回合开始，旧卡立即折叠 */
const AGC_COLLAPSE_GRACE_MS = 120_000;

/** 结论 markdown → 纯文本（折叠摘要正文用）：剥标题/代码围栏/表格分隔行与常见
 *  行内记号后拼接，行数由两行截断收口 */
function agentCardPlainText(md: string): string {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('```') && !/^\|[-| :]+\|?$/.test(l))
    .map((l) => l.replace(/^[-*+]\s+/, '').replace(/[*`>_]+/g, ''))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 落流卡（2026-11-11 改版）：
 * - 实时投影（活动卡取消后本卡即实时界面）：本会话运行中且本卡为当前轮
 *   （landed running）→ 直接以 agent store 流投影渲染（随 delta 平滑流式）
 * - 状态校正兜底：落流停在 running 而会话实际已收口（无人 PATCH 场景）→ 按 done 渲染
 * - 摘要折叠（2026-11-11 用户拍板，仅 IM 聊天页、工作台不走本组件）：收口后折叠为
 *   迷你卡——完成起 2 分钟宽限到点自动折叠，宽限期内新回合开始立即折叠
 * - 应答条（仅回答 agent 的交互）：待审批黄条 + D20 提问蓝条——与聊天页弹框同感
 */
export function AgentCardMsg({ body }: { body: AgentCardBody }) {
  const { token } = theme.useToken();
  // 订阅只取引用（2026-11-11 卡顿修复）：此前 4 个 selector 内各做 O(流长) 扫描，
  // store 每次 set（流式期每 delta）都会执行——聊天里每轮一张历史卡，成本 ×卡数；
  // 现 selector 全部 O(1) 取引用，派生计算移入 useMemo（仅相关引用变化时重算）
  const sid = body.session_id ?? null;
  const sessions = useAgentStore((s) => (sid ? s.sessions : undefined));
  // 本会话事件流（运行中实时投影数据源；引用仅随本会话事件变化）
  const stream = useAgentStore((s) => (sid ? s.streams[sid] : undefined));
  const respondPermission = useAgentStore((s) => s.respondPermission);
  const respondClarifyAction = useAgentStore((s) => s.respondClarify);
  // 会话真实运行态：会话行运行态，或回合权威口径仍开着（最后一条 user 未收口
  // turnDoneAt 且已有回答事件）——后者兜底会话行缺失/迟到（重载竞态），与
  // EmbeddedAgentSync 收口判定同口径
  const live = useMemo(() => {
    if (!sid) return false;
    const m = sessions?.find((x) => x.id === sid);
    if (m && AGENT_LIVE_STATUSES.has(m.status)) return true;
    if (!stream) return false;
    let lastUser: { turnDoneAt?: number } | null = null;
    let hasReply = false;
    for (const it of stream) {
      if (it.kind === 'user') lastUser = it;
      else hasReply = true;
    }
    return !!lastUser && !lastUser.turnDoneAt && hasReply;
  }, [sid, sessions, stream]);
  // 待审批（三端同步）：该会话最近一条未决 permission
  const pendingPerm = useMemo(() => {
    if (!stream) return null;
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const it = stream[i];
      if (it.kind === 'permission' && it.outcome === null) return it;
    }
    return null;
  }, [stream]);
  // D20 待决提问（三端同步同审批口径：卡内快捷单选作答，弹框承载多选/补充）
  const pendingClarify = useMemo(() => {
    if (!stream) return null;
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const it = stream[i];
      if (it.kind === 'clarify' && it.answer === null) return it;
    }
    return null;
  }, [stream]);
  const respondClarify = (answers: string[]) => {
    if (pendingClarify && pendingClarify.kind === 'clarify') {
      respondClarifyAction(pendingClarify.request.questionId, answers);
    }
  };
  // 实时投影：仅当前轮（本卡 status=running）注入——历史轮卡（done）保持落流终态；
  // 投影源=当前轮切片（最后一条 user 之后，2026-11-11 修「新卡带上一轮答案」）
  const liveProj = useMemo<AgentCardBody | null>(() => {
    if (!live || body.status !== 'running' || !stream) return null;
    const { stages, sources, rounds } = stagesFromStream(currentRoundItems(stream));
    return { ...body, stages, sources, rounds, question: roundQuestionOf(stream) ?? body.question };
  }, [live, body, stream]);
  const display: AgentCardBody =
    liveProj ??
    // 状态校正兜底（无人 PATCH 场景）：落流停在 running 而会话已收口 → 按 done 渲染
    (body.status === 'running' && !live ? { ...body, status: 'done', ended_at: body.ended_at ?? Date.now() } : body);

  // ---- 一行折叠态（仅 IM；口径见组件头注）----
  const done = display.status !== 'running';
  const [expanded, setExpanded] = useState(!done);
  const graceTimerRef = useRef<number | null>(null);
  const clearGrace = useCallback(() => {
    if (graceTimerRef.current != null) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearGrace, [clearGrace]); // 卸载清定时器
  // running→done 转换（终态 PATCH/死会话校正）：起 2 分钟宽限，到点后台折叠
  const prevDoneRef = useRef(done);
  useEffect(() => {
    if (!prevDoneRef.current && done) {
      clearGrace();
      graceTimerRef.current = window.setTimeout(() => {
        graceTimerRef.current = null;
        setExpanded(false);
      }, AGC_COLLAPSE_GRACE_MS);
    }
    prevDoneRef.current = done;
  }, [done, clearGrace]);
  // 宽限期内新回合开始（同会话流 user 条目增加）且本卡已收口 → 立即折叠
  const userCount = useMemo(() => (stream ? stream.filter((it) => it.kind === 'user').length : 0), [stream]);
  const prevUserCountRef = useRef(userCount);
  useEffect(() => {
    if (userCount > prevUserCountRef.current && done) {
      clearGrace();
      setExpanded(false);
    }
    prevUserCountRef.current = userCount;
  }, [userCount, done, clearGrace]);
  /** 手动展开/收起：清宽限定时器（手动优先，本轮不再后台抢折） */
  const toggleExpanded = useCallback(() => {
    clearGrace();
    setExpanded((v) => !v);
  }, [clearGrace]);

  // 空终态（无过程无结论且非运行）不渲染——与 AgentProcessCard 空卡口径一致
  if (!expanded && display.stages.length === 0 && !live) return null;

  const respond = (decision: 'allow' | 'deny') => {
    if (!pendingPerm || pendingPerm.kind !== 'permission') return;
    const { requestId } = pendingPerm.request;
    const bridge = getAgentBridge();
    if (decision === 'allow') {
      void bridge.respondPermission(requestId, 'allow', 'once');
      respondPermission(requestId, 'allow', 'once');
    } else {
      void bridge.respondPermission(requestId, 'deny');
      respondPermission(requestId, 'deny');
    }
  };
  // 折叠摘要卡（2026-11-11 用户口径）：首行「Agent 状态：本轮问题」+ 思考过程行 +
  // 正文两行截断省略号——等宽统一、结构固定，点开完整内容（壳体 inline+token）
  if (!expanded) {
    const stateLabel =
      display.status === 'done' ? '已完成' : display.status === 'failed' ? '失败' : display.status === 'cancelled' ? '已取消' : '运行中';
    const stateColor =
      display.status === 'done' ? token.colorSuccess : display.status === 'failed' || display.status === 'cancelled' ? token.colorError : token.colorTextSecondary;
    const hasThinking = display.stages.some((s) => s.t === 'thinking');
    const durMs = display.started_at && display.ended_at ? display.ended_at - display.started_at : null;
    let conclusionText = '';
    for (let i = display.stages.length - 1; i >= 0; i -= 1) {
      if (display.stages[i].t === 'conclusion') {
        conclusionText = agentCardPlainText(display.stages[i].md ?? '');
        break;
      }
    }
    return (
      <div
        data-testid="agent-card-collapsed"
        role="button"
        tabIndex={0}
        title="点击展开完整内容"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          width: 448,
          maxWidth: '100%',
          height: 112,
          overflow: 'hidden',
          padding: '8px 10px',
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 10,
          background: token.colorBgContainer,
          color: token.colorText,
          fontSize: 12,
          cursor: 'pointer',
        }}
        onClick={(e) => {
          e.stopPropagation();
          toggleExpanded();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpanded();
          }
        }}
      >
        <Flex align="center" gap={5} style={{ minWidth: 0, flexShrink: 0 }}>
          <Bot size={13} />
          <span style={{ fontWeight: 600, flexShrink: 0 }}>Agent</span>
          <span style={{ flexShrink: 0, color: stateColor }}>{stateLabel}</span>
          <span style={{ flexShrink: 0, color: token.colorTextSecondary }}>：</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textAlign: 'left',
              color: token.colorTextSecondary,
            }}
          >
            {body.question?.trim() || '本轮对话'}
          </span>
          <ChevronDown size={13} style={{ flexShrink: 0, color: token.colorTextQuaternary }} />
        </Flex>
        {hasThinking ? (
          <Flex
            align="center"
            gap={5}
            style={{ flexShrink: 0, color: token.colorPrimary, background: 'var(--bbc-primary-light)', borderRadius: 6, padding: '3px 8px', minWidth: 0 }}
          >
            <Lightbulb size={12} />
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}>
              思考过程 · {agentStatsText(display.stages, durMs)}
            </span>
          </Flex>
        ) : null}
        {conclusionText ? (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              whiteSpace: 'normal',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              lineClamp: 2,
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
          >
            {conclusionText}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <>
      <AgentProcessCard
        body={display}
        startedAt={display.started_at}
        testId="agent-card-msg"
        onCollapse={toggleExpanded}
        actions={
          <Flex gap={6} onClick={(e) => e.stopPropagation()}>
            {pendingPerm && pendingPerm.kind === 'permission' && live ? (
            <Flex
              align="center"
              gap={8}
              style={{
                marginTop: 6,
                padding: '6px 10px',
                borderRadius: 8,
                width: '100%',
                background: token.colorWarningBg,
                border: `1px solid ${token.colorWarningBorder}`,
              }}
            >
              <span style={{ flex: 1, fontSize: 12, color: token.colorWarning, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                待你审批：{pendingPerm.request.tool}
              </span>
              <Button size="small" onClick={() => respond('allow')}>
                允许
              </Button>
              <Button size="small" variant="secondary" danger onClick={() => respond('deny')}>
                拒绝
              </Button>
            </Flex>
          ) : null}
          {pendingClarify && pendingClarify.kind === 'clarify' && live ? (
            <Flex
              align="center"
              gap={8}
              wrap="wrap"
              style={{
                marginTop: 6,
                padding: '6px 10px',
                borderRadius: 8,
                width: '100%',
                background: token.colorInfoBg,
                border: `1px solid ${token.colorInfoBorder}`,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: token.colorInfo, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Agent 提问：{pendingClarify.request.question}
              </span>
              {pendingClarify.request.options.map((o) => (
                <Button key={o.label} size="small" title={o.description} onClick={() => respondClarify([o.label])}>
                  {o.label}
                </Button>
              ))}
            </Flex>
          ) : null}
          </Flex>
        }
      />
    </>
  );
}
