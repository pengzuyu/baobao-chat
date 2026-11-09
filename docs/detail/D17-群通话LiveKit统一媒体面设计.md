# D17 - 群通话 LiveKit 统一媒体面设计

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（已拍板待实施） |
| 拍板日期 | 2026-11-09 |
| 上游文档 | [05-音视频通话设计](../05-音视频通话设计.md)（媒体面 delta 见 §7）· [16-部署运维](../16-部署运维与非功能设计.md)（容量表沿用 1k 档）· [D16-子Agent三形态](D16-子Agent三形态与Run记录模型设计.md)（纪要跟踪衔接） |
| 本篇范围 | 群通话媒体面选型落地 · 1v1 统一 SFU · 录制与会议 AI 总结管道 · P0–P2 分期 |

---

## 0. 决策记录

| 决策点 | 拍板 | 说明 |
|---|---|---|
| A 媒体面 | **LiveKit 自建** | 替换 bbw-media 占位；否决自研 mediasoup media-svc（数月工作量）与外链会议软件（拿不到音频流，AI 总结不可行） |
| B 1v1 归属 | **统一 LiveKit**（覆盖"保留 P2P"的建议） | 代价与收益见 §0.1 |
| C ASR 选型 | **P2 启动时再定** | aigw provider 抽象留接口位，云端 bigmodel 与本地 whisper 都能接；不影响 P0/P1 |
| D 录制策略 | **默认关 + 发起人勾选 + 入会全员告知** | 启用 docs/05 §6.5 预留的 `rtc:record:start` 权限点 |

### 0.1 统一 LiveKit（决策 B）的代价与收益

| 项 | 影响 |
|---|---|
| 服务器带宽 | 1v1 不再零成本：视频 1v1 每对约占服务器 4~8Mbps（收发合计）；1k 档预算内（§6） |
| 客户端 | 只维护一套媒体引擎：`RtcEngine` P2P 分支与 `rtc.signal` SDP/ICE 中转退役 |
| 可用性 | media 容器故障 = 全司不可通话（单点）；v0.1 靠容器重启策略兜底，多节点是后续容量档的事 |
| 净收益 | 弱网策略/simulcast/重连全由 LiveKit 自带，客户端免开发；行为一致性 |

## 1. 背景与缺口

- rtc 域信令/状态机/通话卡片服务端已实现（1v1 P2P 可用）；群通话服务端信令齐（invite/join/席位）但媒体面 bbw-media 无源码；客户端 `RtcEngine` 单 `RTCPeerConnection` 不支持多人。
- 会议 AI 总结（设想：录音 → 转写 → 提取待办/任务/人物 → 跟踪）要求**媒体面在自家拓扑内**，这是否决外链路线的硬约束。

## 2. 目标架构

```
主窗(Tauri)                        会议窗(独立 WebviewWindow，UI 沿用 05 篇 §3.1)
  │ rtc.* 信令(invite/ringing/accept/busy/卡片)     │ livekit-client SDK
  ▼                                                ▼ wss + SRTP/UDP
bbw-server(Go) ── server-sdk-go ──► livekit-server ──► egress(P1，录音)
  │ call_session/call_member/忙线/席位              │ webhook 回调 participant_*
  └─ aigw(P2：ASR→LLM→纪要/待办)              redis(egress 协调，启用闲置容器)
```

| 层 | 组件 | 职责 |
|---|---|---|
| 业务信令 | bbw-server rtc 域（已有，基本不动） | invite/ringing/accept/bye/忙线/席位判定/call_card/call_session；**不再中转 SDP/ICE** |
| 媒体面 | livekit-server | 房间/转发/simulcast 自适应/内嵌 TURN |
| 录制 | livekit egress（P1） | room 音频合成落盘 |
| AI | aigw + agent（P2） | ASR→LLM 结构化→纪要卡片→任务→D16 跟踪 |

## 3. 服务端接入

### 3.1 compose（media profile 重定义）

- `bbw-media` 容器 → `livekit/livekit-server`；镜像经内网 Harbor（172.16.105.109:30003）预拉 tag 别名，同 pgvector 经验。
- 端口：`7880/tcp`（wss 信令）；UDP `40000-50100` 沿用 media 档规划（`rtc.port_range_start/end`）。
- P1 起新增 `livekit/egress` 容器；**启用现有闲置 redis**（egress 协调依赖）。
- coturn 容器退役 → livekit 内嵌 TURN（`turn.enabled`，3478/udp；TLS 5349 视证书情况后定）。
- 新增环境变量：`BBW_LIVEKIT_API_KEY/SECRET`（token 签发）、`BBW_LIVEKIT_URL`（运行时下发用）。
- nginx：`/rtc/` 由 →media:8082 改为 →livekit:7880（见 3.2 ②）；UDP 段不经 nginx。

### 3.2 域名与入口（固定域名终态对齐）

- **客户端零写死**：`GET /api/v1/rtc/config`（05 篇 §6.2 已登记）扩展返回 `{ livekit_url, ice_servers }`——出包只写 API 域名，媒体面地址运行时下发，迁移仍纯后端侧。
- 入口两选一（P0 验证）：① 独立子域 `mtg.xxx` 443→7880；② nginx `/rtc/` 反代（验证 livekit 子路径支持，不行走①）。

### 3.3 token 签发（新 REST）

- `GET /api/v1/calls/{id}/token`：校验会话成员 + call_session 进行中 + 席位策略。
- JWT（livekit 同源校验）：`identity = {uid}:{device_id}`（多端各自入房，对齐 call_member 按设备行）、`name` 显示名；grants：room=`call_{call_id}`、canPublish/canSubscribe/canPublishData；TTL 对齐最长通话 4h。

### 3.4 房间生命周期

- 房间名 `room_id = call_{call_id}`，连接时自动建。
- webhook：participant_joined/left → 同步 `call_member` 状态、进行中卡片人数；全员离开 30s 自动结束落卡片（05 篇 §7.4 沿用）。
- 席位（视频 16/音频 64）在业务层判定：token 签发时校验 + `rtc.state` 广播"视频席位已满，仅音频加入"。
- `call_session.mode` 恒记 `sfu`（字段保留，兼容历史 1v1 P2P 记录）。

## 4. 客户端接入

- 引擎：`RtcEngine` → `LiveKitEngine`（livekit-client）；adaptiveStream/dynacast 自带弱网降层，05 篇 §3.4 降级表大半免开发。
- 1v1：invite/accept 流程**不变**，accept 后双端 GET token → connect(room)；状态机 connecting/reconnecting 映射 SDK connect/重连事件。
- 群：工具栏发起 / 卡片[加入] → token → 会议窗口 connect；新加入者不受发起时刻限制（rtc 域既有能力）。
- 会议窗口：Tauri 独立 WebviewWindow（主窗消息照常），PiP 最小化沿用 05 篇 §3.2 规划。
- `rtc.signal` 收发路径退役（协议枚举保留兼容旧客户端）。

## 5. 录制与会议 AI 总结（P1→P2）

### 5.1 Egress 录音（P1）

- 默认关；发起人发起时勾选"录制并生成纪要"（权限点 `rtc:record:start`）；入会全员横幅"本次通话正在录制"+ 录制红点，不同意者可退出。
- egress room-composite audio-only → 存储：本地 `meetings/` 或 MinIO（S3 兼容 endpoint，P1 验证二选一；若走 MinIO 则闲置容器就此启用）。
- 录音归文件域，元数据挂 call_session（record_url、recorded_by、consent 版本）。

### 5.2 ASR → LLM → 任务（P2，ASR 选型待 C 复拍）

- 音频 → ASR（aigw 新增 `asr` provider 类型，云 bigmodel / 本地 whisper 均可接）→ 文字稿（尽量带时间轴/说话人分离）。
- 文字稿 + 参会人名单 → LLM（现有 openai_compatible，GLM）→ 结构化 JSON：`{摘要, 决议, 待办[{内容,负责人,期限}], 人物提及}`。
- 产出：① `meeting_minutes` 纪要卡片（挂录音/文字稿附件）② 待办写任务域（依赖写操作链 P1 完成度）。
- 跟踪：对接 D16 子 Agent——定时扫描到期/未更新待办 → @负责人私聊催办 → 状态回流任务域。

## 6. 资源与容量（1k 档沿用）

- 统一 SFU 后所有通话计服务器流量：并发 50~100 与会者 → 200~500Mbps、media 3~6 核，混部 8C16G 预算内（docs/16 1k 档原口径；1v1 视频每对 +4~8Mbps 已含在并发估算内）。
- 存量变化：redis 从闲置转 egress 协调；coturn 退役；带宽仍是唯一硬通货。

## 7. docs/05 delta 清单（本篇拍板的回填）

| 节 | 变更 |
|---|---|
| §1.1 S1 / 技术基线 | 内网优先 P2P → 统一 LiveKit SFU |
| §1.1 S2 | mediasoup → LiveKit |
| §1.2 原则 2 | "内网优先直连" → "单一媒体面" |
| §1.3 | 录制提前 P1、纪要 P2（原阶段四） |
| §4.1 | accept 后取 token 进房；rtc.signal 中转退役（图以本篇为准） |
| §5 | mediasoup 房间模型整章存档，由本篇 §3 取代 |
| §6.2/6.3 | 新增 `GET /calls/{id}/token`；`/rtc/config` 扩展；rtc.signal 标注退役 |
| §7.2 | P2P↔SFU 自动切换作废（统一 SFU） |

## 8. 分期

| 期 | 内容 | 备注 |
|---|---|---|
| **P0** | livekit-server 进 compose；`/rtc/config` 扩展 + token 接口 + webhook 同步；客户端 LiveKitEngine + 会议窗口；1v1/群统一接入；音频 + 720p 视频 + 静音/摄像头/挂断/成员列表 | MVP |
| **P1** | 屏幕共享（WKWebView getDisplayMedia 风险：可能需 Tauri 原生捕获兜底）；演讲者布局；Egress 录音 + 开关/告知；TURN TLS | |
| **P2** | ASR→LLM 纪要→待办→D16 Agent 跟踪闭环（C 决策此时复拍） | 依赖写操作链 |

## 9. 开放问题/风险

1. livekit 镜像入内网 Harbor（慢拉取 → tag 别名，同 pgvector 经验）。
2. nginx 子路径反代可行性，不行走独立子域。
3. egress 本地落盘 vs MinIO S3 兼容（P1 验证）。
4. WKWebView 屏幕共享支持度（P1，必要时 Tauri 原生层）。
5. webhook/rtc registry 仍单实例口径（多实例问题独立跟踪，不在本篇范围）。
6. egress 音频说话人分离（diarization）能力边界，P2 实测。
