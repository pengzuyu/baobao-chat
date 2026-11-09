/**
 * /rtc 最近通话页（D04 PRTC-06 阶段一务实版）：
 * 阶段一不建通话记录 REST（GET /api/v1/calls 登记）——"最近通话"由消息流内
 * call_card 过滤派生（拉会话列表 → 各会话最新消息页 → 过滤 call_card 归并倒序）。
 * 「隐藏」=仅本端视图删除（OQ-B18 拍板：服务端按租户审计策略保留，文案明示）。
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EyeOff, PhoneCall } from 'lucide-react';
import { http } from '../../../shared/api/http';
import { emit } from '../../../shared/bus';
import { Avatar } from '../../../shared/ui/Avatar';
import { CallCard, type CallCardBody } from '../../../shared/components/CallCard';
import { useRtcStore } from '../store/rtcStore';
import type { Conversation } from '../../im/model/types';

const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK !== '0';

/** 消息流内的 call_card 行（REST 最小投影） */
interface CallCardRow {
  msgId: string;
  convId: string;
  convName: string;
  senderId: string;
  ts: number;
  body: CallCardBody;
}

interface RawMessage {
  msgId: string;
  convId: string;
  senderId: string;
  type: string;
  ts: number;
  body: CallCardBody;
}

/** 本端隐藏的通话记录 msgId 集（OQ-B18：仅本地视图删除，不触服务端） */
const HIDDEN_CALLS_KEY = 'bbw.rtc.hidden-calls';

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_CALLS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveHidden(ids: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_CALLS_KEY, JSON.stringify([...ids]));
  } catch {
    // 私隐模式/配额：静默（下次会话恢复显示）
  }
}

/** 拉最近通话：convs → 每会话最新 50 条过滤 call_card（演示规模直拉；正式版换 API-RTC-02） */
async function fetchRecentCalls(myUid: string): Promise<CallCardRow[]> {
  const convs = await http.get<{ items: Conversation[] }>('/convs?filter=all');
  const rows: CallCardRow[] = [];
  await Promise.all(
    (convs.items ?? []).map(async (c) => {
      try {
        const data = await http.get<{ items: RawMessage[] }>(
          `/convs/${encodeURIComponent(c.id)}/messages?order=-seq&limit=50`,
        );
        for (const m of data.items ?? []) {
          if (m.type === 'call_card' && m.body && typeof m.body === 'object' && 'call_id' in m.body) {
            rows.push({ msgId: m.msgId, convId: c.id, convName: c.name, senderId: m.senderId, ts: m.ts, body: m.body });
          }
        }
      } catch {
        // 单会话失败跳过（不阻断整页）
      }
    }),
  );
  void myUid;
  return rows.sort((a, b) => b.ts - a.ts);
}

export function RecentCallsPage() {
  const myUid = useRtcStoreUid();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['rtc', 'recent-calls', myUid],
    queryFn: () => fetchRecentCalls(myUid),
    enabled: !USE_MOCK && !!myUid,
  });
  // 本端隐藏集（OQ-B18）：仅视图删除——服务端按租户审计策略保留记录
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden());
  useEffect(() => {
    saveHidden(hidden);
  }, [hidden]);
  const rows = (data ?? []).filter((r) => !hidden.has(r.msgId));

  const hideRow = (msgId: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(msgId);
      return next;
    });
  };

  return (
    <div className="rtc-recent-page">
      <header className="rtc-recent-page__header">
        <h2>通话</h2>
        <p className="rtc-recent-page__hint">
          阶段一（D04 务实版）：1v1 音频/视频通话 · WebRTC P2P 直连（服务端纯信令）；群通话/屏幕共享/节点迁移待阶段二。
          媒体设备不可用环境将自动进入「无媒体通话模式」（信令照走）。
        </p>
      </header>

      <section className="rtc-recent-page__list" data-testid="rtc-recent-list">
        {USE_MOCK ? (
          <div className="rtc-recent-page__empty">mock 模式无通话数据（连真实后端后展示最近通话）</div>
        ) : isPending ? (
          <div className="rtc-recent-page__empty">加载中…</div>
        ) : isError ? (
          <div className="rtc-recent-page__empty">
            加载失败，
            <button type="button" onClick={() => void refetch()}>
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="rtc-recent-page__empty" data-testid="rtc-recent-empty">
            还没有通话记录——打开一个单聊，点击会话头「通话」发起第一次通话
          </div>
        ) : (
          rows.map((r) => (
            <div className="rtc-recent-page__row" key={r.msgId} data-testid="rtc-recent-row">
              <Avatar name={r.convName} size={32} />
              <div className="rtc-recent-page__row-main">
                <div className="rtc-recent-page__row-head">
                  <span className="rtc-recent-page__conv">{r.convName}</span>
                  <span className="rtc-recent-page__time">{new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}</span>
                </div>
                <CallCard
                  body={r.body}
                  mine={r.senderId === myUid}
                  onRecall={(video) => emit('im:invoke-call', { convId: r.convId, video })}
                />
              </div>
              <button
                type="button"
                className="rtc-recent-page__hide icon-btn"
                title="隐藏本条（仅本端生效，服务端按审计策略保留通话记录）"
                aria-label="隐藏本条通话记录"
                onClick={() => hideRow(r.msgId)}
              >
                <EyeOff size={14} />
              </button>
            </div>
          ))
        )}
      </section>

      <footer className="rtc-recent-page__foot">
        <PhoneCall size={14} />
        通话记录来自会话消息流（call_card）；服务端通话态为内存注册表，重启后以消息流为准。
        「隐藏」仅从本端列表移除，服务端按租户审计策略保留通话记录（OQ-B18）
      </footer>
    </div>
  );
}

/** myUid 订阅（app 组合层注入 rtcStore，D01 §12.2 组合层注入口径） */
function useRtcStoreUid(): string {
  return useRtcStore((s) => s.myUid);
}
