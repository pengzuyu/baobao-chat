# D26 · 全站 UI 组件库切换 Ant Design 详细设计

> 状态：2026-11-13 设计定稿（用户拍板：除 IM 气泡外全量切 antd）。编码进度：O1 ✅（主题基线+基础层+kb 样板，含口径修订——旧自研样式一律退役走 antd 原生观感）、O2 ✅（admin 域 15 页两轮：控件层+结构层旧类全归零）、O3 ✅（六域 20 文件同口径）、O4 ✅（agent 工作台 8 文件，过程卡族保留）、O5 ✅（IM 外围 9 文件，气泡/输入区保留）、O6 ✅（global.css **9895→4881 行** grep 驱动清扫+孤儿模块删除+keyframes 同名拆分；>3200 偏差=仍被引用的保留面：IM 核心/kb 博客体未换装页/Agent 过程卡，继续压行需 kb 博客体换装另行立项）；**仅剩 O7 用户真机走查（§7 五项）**。
> 定位：**全站视觉与交互基座换制，非局部美化**。自研 BEM+global.css(10384 行) 体系收敛为「布局层」；antd 5 承接全部通用交互件（表单/弹窗/下拉/表格/树/页签/提示）。
> 上游：[D01](D01-客户端总体详细设计.md)（设计系统/六态/断点——六态与断点规范继续有效）、tokens.css（--bbw-\* 令牌升格为 antd theme 唯一色源）。
> 关联：[D24](D24-知识库博客化详细设计.md)（kb 域为样板域）、providers.tsx（ConfigProvider 主题桥接已通）、vite.config（antd 独立 chunk 已拆）。
> 正交不动：IM 气泡/消息流结构（见 §4 保留清单）、http/i18n/store/路由、--bbw-\* 令牌文件（反而升格）。

## 0. 背景与拍板决策

背景：自研体系下每个新页面的 UI 细节（弹窗/下拉/表单/页签/树）都要手写+真机抠——D24 三轮真机修正印证了边际成本。antd 已局部使用（18 文件）且主题桥接打通。

**拍板决策（2026-11-13，用户裁决，勿重提）**：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 切换范围 | **除 IM 气泡/消息流结构外，全站切 antd**（含 admin/settings/auth/contacts/mail/expert/eco/agent/kb 及 IM 域的弹窗·表单·列表外围） |
| 2 | 选库 | **Ant Design 5**（已在依赖/已桥接/组件面最大/中文生态）；**Arco 否决**（风格更像但双库并存得不偿失） |
| 3 | 风格基线 | 现有视觉**零漂移**：--bbw-\* 令牌全量灌 antd theme（主色 #2e6be6、圆角 6、现灰阶），antd 只换"手感"不换"观感" |
| 4 | 表单策略 | **控件层替换，不强推 Form 重写**：input→Input / select→Select / textarea→Input.TextArea / checkbox→Checkbox / radio→Radio.Group；校验维持现有手写；antd Form 仅新页面使用 |
| 5 | 确认框 | 24 处 window.confirm 全换 `Modal.confirm`（含危险态红色按钮） |
| 6 | 提示统一 | 全站 toast 统一 antd message（ChatPage 自研 ann-banner/favToast 退役）；http 全局兜底已 antd |
| 7 | 保留自研 | §4 保留清单（IM 气泡族/MarkdownText/ctx-menu/Splitter/StateView 壳/Logo/ErrorBoundary） |
| 8 | CSS 终态 | global.css 10384 → **≈3000 行**（只留布局/气泡/阅读排版/令牌/动效），基元与各域弹窗表单段删除 |

## 1. 现状盘点（2026-11-13 探针实测）

| 资产 | 规模 | 去向 |
|---|---|---|
| 页面 | 35+（9 域：im/kb/agent/admin×15/settings×7/auth/contacts/mail/expert/eco） | 按域迁移（§5） |
| 自研 Button | 32 文件 / 137 处 JSX | O1 包装过渡（内部改 antd Button，API 不动全站零改），调用点后续随手换 |
| StateView/Skeleton | 各 19 文件 | StateView 保留壳；Skeleton 内部换 antd Skeleton（SkeletonList 包装 API 不动） |
| 自研弹窗/抽屉 | 15+（forward/merge/person-picker/create-conv/read-receipt/file-preview/notif/kb-dialog×2/role-editor/org 创建/exp×2/plugin-drawer/mail-compose/mail-settings） | 全换 antd Modal/Drawer |
| 原生表单件 | input 93 / select 26 / textarea 13（admin 58、settings 19 为重灾区） | 控件层换 antd（§0-4） |
| window.confirm | 24 处 | Modal.confirm |
| ctx-menu 自研 | 2（MsgContextMenu/ConversationList 右键）+轻浮层若干 | 保留（长按/自定位精细逻辑 antd 不覆盖） |
| global.css | 10384 行（IM 3200/KB 2000/Agent 1800/contacts 580/admin 600/mail 400/eco 350/settings 470/auth 115/基元 155） | O6 清扫至 ≈3000 |
| antd 已用 | 18 文件（auth 全套/contacts/settings 部分/AiProviders Drawer/审批 Modal/工作台 Dropdown+Modal.confirm） | 基线证明混排可行 |
| 死 CSS | kb-drawer/kb-grant/kb-jobs 三节（D24 退役件） | O6 顺删 |

## 2. 主题与令牌对齐（O1 核心，全站观感基线）

providers.tsx ConfigProvider theme.token（亮色）：

| antd token | 取值（=令牌） | antd token | 取值 |
|---|---|---|---|
| colorPrimary | #2e6be6（--bbw-primary） | borderRadius | 6 |
| colorInfo | 同 primary | fontSize | 14 |
| colorSuccess/Warning/Error | 23a55b / e6a23c / e5484d | controlHeight | 32 |
| colorText | var(--bbw-gray-9) #272e3b | colorBgLayout | var(--bbw-gray-2) |
| colorTextSecondary | #4e5969（gray-8） | colorBgContainer | #fff（gray-1） |
| colorBorder / colorBorderSecondary | #e5e6eb（gray-3）/ #f2f3f5（gray-2） | fontFamily | --bbw-font-family |

暗色：`darkAlgorithm` + 同一映射函数读暗色令牌覆盖（gray-1↔深底等；themeConstants 单源函数化 `antdThemeFrom(mode)`）。components 层微调：Button{borderRadius:6}、Modal{titleFontSize:16}、Tabs{cardGap:8}、Table{headerBg:gray-2}。**验收基线：新旧组件混排截图对比，主色/灰阶/圆角无肉眼差异**。

## 3. 组件映射表（自研 → antd）

| 自研 | antd | 迁移方式 |
|---|---|---|
| Button（shared/ui） | Button | O1 内部包装（variant→type：primary→primary、secondary→default、text→text、danger→danger）；调用点 API 零改动 |
| 各域 modal 遮罩+卡片 | Modal（确认类）/ Drawer（侧栏类：merge/plugin/exp 详情/mail settings） | 逐个换，Esc/遮罩关闭/滚动锁免费获得 |
| kb-tabs | Tabs（卡片式，items 驱动；home tab `closable:false`） | kb 域样板首换 |
| ArticleTree/目录树 | Tree（loadData 懒加载、title 自定义渲染、目录 hover「+」用 titleRender） | kb 样板 |
| admin-table 各表 | Table（columns/ds、分页、scroll sticky） | O2 admin 域 |
| bbw-input/原生三件 | Input/Input.TextArea/Select（含 ConvInfoSidebar 4 个 select） | 控件级替换 |
| window.confirm×24 | Modal.confirm（危险操作 danger okButtonProps） | O2/O3/O5 逐域清 |
| favToast/ann-banner | antd message | O5 |
| Empty/Avatar | antd Empty/Avatar（Logo 保留自研） | 直接换 |
| Skeleton | antd Skeleton（SkeletonList/SkeletonBlock 保留为薄包装） | O1 |
| Dropdown/Popover/Tooltip | 已用/补面（会话列表右键保留自研；Tooltip 全站补） | 随域 |
| Pagination（若有手写） | Pagination | 随域 |
| **保留自研** | — | StateView（六态壳）、Splitter（antd 无）、ErrorBoundary、Logo、MarkdownText+agent-md、ctx-menu×2、MsgBubble/消息流/输入区/EmojiPicker/多选条/ApplyCard、PersonPickerCore 列表内容、kb 阅读页排版（kb-article 正文书版式） |

## 4. IM 域两列口径（拍板 1 的细化）

**保持自研**：MessageBubble（气泡+悬浮条+灯箱+长按锚点）、MsgContextMenu+msgActions、MultiSelectBar、ApplyCard、ConversationList 行渲染（右键菜单本体自研）、MessageInput（textarea 核心/引用条/禁言态）、EmojiPicker、ChatHeader、ConvInfoSidebar 布局、未读分隔线/回底浮标、EmbeddedAgentSync 落流卡。
**切 antd**：ForwardModal/CreateConvModal/ReadReceiptModal/PersonPickerModal 外壳/MergeForwardDrawer/FileSendPreview 外壳/notif 公告弹层 → Modal/Drawer；ConvInfoSidebar 表单件（input×2+select×4+textarea）；PersonPicker/Forward 搜索框 → Input；favToast → message；已读未读 tab → Tabs。

## 5. 实施批次（EXECUTION-PLAN 批次 O；每批一提交一推送，tsc+vite build 门禁，真机用户验）

| # | 内容 | 要点 |
|---|---|---|
| O1 | 主题对齐+基础层+kb 样板 | antdThemeFrom 单源+暗色；Button/Skeleton/Empty/Avatar 包装化；kb：Tabs/Tree/Modal（CreateDoc/CreateDir）/Input；kb 相关段 CSS 标记待删 |
| O2 | admin 域（15 页） | Table 化清单表、全部表单控件、内联弹窗×2→Modal、confirm×14、AiProviders 对齐 |
| O3 | settings+auth+contacts+mail+expert+eco | 表单件/弹窗（compose/settings-drawer/exp×2/plugin-drawer）/confirm；auth 已大半 antd 收尾 |
| O4 | agent 工作台 | 会话列表/四张设置卡/报告页/记忆页表单件+弹窗；过程卡/StreamMessage 保留 |
| O5 | IM 外围 | §4 右列全部（弹窗×6+表单件+toast 统一） |
| O6 | CSS 清扫 | global.css 分域删除（§1 体量→≈3000）：基元/各域弹窗表单段+死代码三节；令牌/reset/动效/保留清单段留下；建 `legacy` 注释标记防误删 |
| O7 | 真机验收 | §7 清单走查 |

依赖顺序：O1 必须先行（主题基线）；O2-O5 可调序互不依赖；O6 最后。

## 6. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| 1 | antd 与 IM 自研气泡混排样式互扰（antd 全局 reset/类名） | antd v5 cssinjs 无全局 CSS 注入；IM 保留段沿用 BEM 命名空间天然隔离；真机重点走查 |
| 2 | 受控表单换件丢行为（focus/onChange 签名） | 控件级替换保持受控写法；Select 换装时 option 值映射单测式走查 |
| 3 | 暗色模式令牌覆盖不全（antd 派生色） | O1 建立亮/暗双套映射函数；真机亮暗切换全页走查 |
| 4 | 包体增长 | antd 按需 import（现状同款）+manualChunks 已拆；O6 后 CSS 收益对冲 |
| 5 | Modal.confirm 异步化（原 confirm 同步阻塞） | 24 处逐个改回调链（都在事件处理器内，无同步依赖语义） |
| 6 | kb 树懒加载行为差异（antd Tree loadData） | 样板域先行真机验证再复制到其余树场景 |

## 7. 验收清单（真机）

1. 亮/暗主题：主色/灰阶/圆角与切前无肉眼差异；antd 组件与自研保留件混排无违和。
2. kb：tab 条/文章树（懒加载+新建子目录）/两弹窗/搜索输入全 antd 化且功能等价（开文章/建目录/建文章全链）。
3. admin：任一表格页分页排序可用、表单编辑保存等价、危险操作弹 Modal.confirm 红钮。
4. IM：气泡/右键/输入区行为与切前完全一致（回归重点）；转发/选人/已读回执弹窗 antd 化；favToast 变 message。
5. 全站 grep：window.confirm=0、自研 modal-mask 类=0（保留清单除外）、global.css ≤3200 行。
