# RTC 阶段一（D04 务实版）交付物

BaobaoWork 1v1 音视频通话阶段一：服务端纯信令（WebRTC P2P，SDP/ICE 经 `rtc.signal` 透传不落库）+ 通话卡片落 IM 消息流（`call_card`，不建表）+ 客户端通话窗/来电弹窗/最近通话页。

设计依据：`docs/05-音视频通话设计.md` · `docs/detail/D04-通话模块详细设计.md`（阶段一口径差异见文末取舍登记）。

## 一、E2E 验证（双 tab 真实跑，2026-11-07）

环境：`go run ./cmd/bbw-server`（内存存储 + seed alice/bob）+ `cd client && VITE_USE_MOCK=0 npx vite`（:5173）+ 浏览器双标签页。

| # | 步骤 | 结果 | 截图 |
|---|---|---|---|
| 1 | tab A 登录 alice、tab B 登录 bob（口令 demo-pass-123） | 双端进入 /im | — |
| 2 | alice 打开 alice-bob 会话 → 会话头 [通话▾] → 视频通话 | 通话窗弹出「正在等待对方接听…」，会话流落 `call_card`（通话中…） | `01-alice-calling.png` |
| 3 | bob 端收到来电 | 来电弹窗（Alice · 视频通话 · 接听/拒接） | `02-bob-incoming.png` |
| 4 | bob 点击接听 | 双端进入「通话中」+ 时长计时（信令层 connected：accept 后首帧 rtc.signal 到达） | `03-alice-connected.png` / `04-bob-connected.png` |
| 5 | 通话 ~25s 后 alice 挂断 | 双端「通话已结束 · 服务端权威时长」；会话流 `call_card` 原地 PATCH 为「通话已结束 · 00:25」（msg.updated 通道） | `05-call-card-ended.png` |
| 6 | alice 进入 /rtc 最近通话页 | call_card 消息流派生最近通话列表（方向/状态/时长/再次呼叫按钮） | `06-rtc-recent-calls.png` |

附带验证过的异常路径（DOM 断言）：

- 振铃 30s 无应答 → 双端 `ended(timeout)`，卡片「无人接听」+ 再次呼叫按钮（E2E 中两次自然触发）；
- connecting 态挂断 → `ended(bye)`，卡片「通话已结束」（duration=0 不显示时长）；
- 同会话重复呼叫 → 5009；非通话成员操作 → 5011；结束后迟到 accept → 5010（服务端单测覆盖）。

### E2E 自动化口径（媒体层不可自动化的既定约定）

自动化浏览器（IAB）无 fake media 设备且 `getUserMedia` 可能挂起（权限弹窗不出现），媒体采集必然失败——阶段一口径：**采集失败/3s 未决自动降级「无媒体通话模式」，信令全流（invite→ringing→accept→offer/answer/ICE 透传→connected→bye→call_card 回写）照常走通**，双端通话窗显示「无媒体通话模式（设备不可用）」徽标。以上截图即该模式下的信令级全绿。

## 二、媒体能力手工验证说明（E2E 覆盖不到的部分）

在具备真实摄像头/麦克风的桌面环境（macOS + Tauri 客户端或 Chrome）手工验证：

1. **准备**：`go run ./cmd/bbw-server`（或 PG 模式）+ `VITE_USE_MOCK=0 npm run dev`；两个浏览器配置文件（或一台真机 + 一台虚拟机）分别登录 alice/bob。
2. **首次授权**：发起视频通话时浏览器/Tauri WebView 弹出摄像头/麦克风授权，允许后通话窗出现本端画中画预览（镜像不做，阶段一登记）。
3. **P2P 媒体**：对端接听后约 1–3s（ICE host 直连，内网同段）远端画面出现；双端能看到对方视频、听到对方声音。同机双浏览器配置文件走 host 回环候选直连。
4. **静音/摄像头开关**：控制条即时生效（track.enabled 本地切换，不发信令）；对端画面在摄像头关闭后冻结/黑帧（阶段一无头像回切，登记）。
5. **计时与时长**：connected 起本地 mm:ss 计时；挂断后卡片时长以服务端结算为准（两者应一致，±1s）。
6. **STUN**：跨网段时经 `stun:stun.l.google.com:19302` 收集 srflx 候选；对称 NAT 无 TURN 兜底会连接失败（阶段二接入 `GET /api/v1/rtc/config` 下发 TURN 短期凭证后重验，登记）。
7. **设备占用**：先在其它 App 占用摄像头再发起通话 → 降级「无媒体通话模式」徽标提示（5008 文案级，阶段一不强分错误码，登记）。

## 三、阶段一取舍登记（与 05/D04 全量设计的差异）

| # | 项 | 阶段一口径 | 全量设计（05/D04） |
|---|---|---|---|
| 1 | 通话规模 | 仅 1v1；群通话/通话中邀请/屏幕共享/节点迁移（rtc.call.moved）/质量面板/弱网降级/重连态/PiP 不做 | S1–S3 全场景 + mediasoup SFU |
| 2 | 媒体面 | WebRTC P2P 直连；STUN google 默认（`rtc.ice_servers` 占位，`GET /api/v1/rtc/config` 未启用） | P2P⇄SFU 自动升降级 + TURN relay 兜底 |
| 3 | 多端响铃 | 服务端按 user 广播（rtc.ringing/answered_elsewhere 不带 did 路由），客户端按 did 过滤；接听端与其余端各取所需 | 服务端按 did 精确路由 |
| 4 | 状态机 | dialing→ringing→connecting→connected→ended；振铃超时 30s（05 篇 45s 收敛，内网演示节奏）；connecting 超时/4h 上限不做；connected 信令层以「accept 后首帧 signal 到达」近似（ICE 完成真值在端侧 connectionstate，UI 先到先亮） | 45s + connecting 10s + 4h + reconnecting 态 |
| 5 | 通话记录 | 不建表：CallRegistry 进程内存态；记录=IM 流 call_card 消息（服务端重启后注册表清空，消息流为准）；「最近通话」从消息流过滤派生（正式版 GET /api/v1/calls 登记） | call_session/call_member PG 表 + REST API-RTC-02/03/04 |
| 6 | 卡片回写 | invite 落卡（status=calling）→ 结束经 message 服务 `UpdateCallCard` PATCH body 复用 msg.updated 扇出（按现有能力择简） | 05 篇「结算时长→卡片→回收房间」全流程 |
| 7 | 推送扇出 | gateway 装配时注入 hub 适配器（RtcPusher），进程内直调 rtc service，不经 eventbus（通话推送瞬态无落库语义） | 多实例 Redis pub/sub |
| 8 | 权限 | `rtc:call:start` v0.1 无权限点字典缺省放行（03 篇登记后接入） | scope 校验 + 403 |
| 9 | 来电通知 | 应用内弹窗（PRTC-03 形态一）；系统横幅/铃声/勿扰（notification 域）不做 | 双形态 + 通知中心 |
| 10 | 忙线 | 被叫端有活动通话时新来电自动回 `rtc.reject{busy}`（客户端判定，INT-RTC-08 简化）；服务端另有 5004（任一方已有进行中通话，invite 时判定） | rtc.call.busy 专用事件 |
| 11 | rtc.ringing 载荷 | `{call_id, caller{id,name,avatar}, call_type, conv_id}`；avatar 恒空（org 用户模型 v0.1 无头像）；offer 不随 ringing 附带（接听后经 rtc.signal 交换） | D04 §5.1 含 offer/ring_id/group/members |

错误码：5004/5006/5009/5010/5011 均已注册于 `server/internal/platform/errors/codes.go` 与 docs/14 篇 §7（无需补登记）。

## 四、复现 E2E

```bash
# 服务端（终端 1）
cd server && go run ./cmd/bbw-server   # 内存存储 + seed alice/bob

# 客户端（终端 2）
cd client && VITE_USE_MOCK=0 npx vite  # :5173

# 浏览器：两个标签页分别登录 alice / bob（口令 demo-pass-123）
# alice：打开 alice-bob 会话 → 会话头电话图标 → 语音/视频通话
# bob：来电弹窗接听 → 双端计时 → 挂断 → 会话流查看 call_card → /rtc 看最近通话
```
