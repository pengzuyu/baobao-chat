# D34 Markdown 富渲染增强（GFM 补齐 + 表格排序筛选 + 代码高亮）

- 日期：2026-11-17 ｜ 状态：**批1-3 编码完成已推（f00873b→cc55a8f→本批），程序侧验证全绿（tsc 0 错 / vite build 8.0s），剩 §5 真机验收（归用户）**
- 前置：[D33](D33-工作台Agent消息流渲染设计.md)（平铺流/MarkdownText 消费方）、[D27](D27-主题机制与色彩规范.md)（token 体系/accent 六色）、[D24](D24-知识库博客化设计.md)（KB 阅读页消费方/链接图片有序列表）
- 动机（用户 2026-11-17 需求原话归纳）：参考 change-my-life 的 markdown 工具（各类颜色、表格排序等交互）或更好的 markdown 组件，优化 agent 内容展示。现状 `shared/components/MarkdownText.tsx` 手写降级渲染：缺表格排序/筛选、代码复制/语言标签/高亮、引用块/删除线/任务列表/hr/嵌套列表/表格对齐，配色全灰调无主色强调。
- 参考物解剖：change-my-life = `marked`（GFM）+ `DOMPurify` + `enhance.js` DOM 后处理（表头三态排序 asc→desc→原序、≥4 行筛选框、代码复制按钮、[file:] 附件卡片+灯箱）；「各类颜色」实为其整体配色观感，无自定义颜色语法。

## 1. 拍板点（勿重提）

| # | 决策 | 内容 |
|---|------|------|
| 1 | **路线 A：自研渲染器增强，不引 markdown 解析库** | 保留手写 React 渲染器（React 元素直出无 v-html，零 XSS 面；memo 流式优化保留），按 change-my-life 能力清单补齐。对比过 B（marked+DOMPurify+v-html+DOM 后处理：XSS 面/流式三连开销最差、React 里最别扭）与 C（react-markdown 全家桶：解析正确性最优但 ~50-60kB gzip+传递依赖十几个）。**桌面端 20-60kB 尺寸差不构成决策因素**（Tauri 本地加载）；真差别=XSS 面/流式 CPU/维护面 |
| 2 | **代码高亮 = highlight.js 子集**（lib/core + 12 门） | bash/json/typescript/javascript/go/rust/python/sql/yaml/diff/xml/css + sh/ts/py/yml/html 等别名；未注册语言回退纯文本。构建实测独立分包 20.88kB（gzip 8.43kB）。PAG-03「不引第三方渲染器」旧规**收窄为「不引 markdown 解析器」**（高亮库不算渲染器） |
| 3 | **表格交互 = React 组件化（MdTable），非 DOM 后处理** | change-my-life 的 v-html 后 nextTick DOM 增强在 React 无对应物；组件局部状态（sortCol/sortDir/filter）流式表格生长自然保持，无需幂等标记 |
| 4 | **配色全走 --bbc-* token** | h1 主色/h2 主色竖条/引用主色竖条+primary-light 淡底/行内码 primary-light+主色字/表头 primary-light+斑马纹+行 hover——随 D27 六色 accent 与亮暗自动联动，消费方零改动 |
| 5 | change-my-life 的 [file:] 附件卡片+灯箱不做 | 绑定其沙箱文件语义；KB 媒体引用有独立 bbcfile:// 设计（D24 N8 已登记待开工） |

## 2. 现状锚点（2026-11-17 核对）

`shared/components/MarkdownText.tsx`（188 行，memo；4 消费方=KB ArticlePanel / D33 工作台 TurnBlock / 日报 AgentReportsPage / IM AgentProcessCard，改一处全生效）；样式 `styles/global.css` .agent-md 段全走 `--bbc-*`；token 单源 `shared/ui/themeConstants.ts` `cssVarsFrom`（accent 六色 × 亮暗 → `--bbc-primary/-hover/-light`）；剪贴板无共享 util（ExtAgentCard L38 copied+1.5s 模式为参考）；client 依赖 14 个零 markdown 残留；vite manualChunks 拆 react/antd/query（500kB 软约束）。

## 3. 机制设计

### 3.1 解析器 GFM 补齐（MarkdownText.tsx）

块级解析抽 `renderBlocks(lines, keyPrefix)` 可递归函数：**引用块**（剥 `>` 前缀递归，`>>` 多轮嵌套自然）/ **水平线**（`---`/`***`/`___` 独行，先于列表判定）/ **列表两级嵌套**（缩进 ≥2 空格挂上一顶层项；ul/ol 统一收集，顶层标记类型切换即分家=旧口径保持）/ **任务列表**（`- [ ]`/`- [x]` → checkbox+完成灰字删除线）/ **表格对齐**（`:---`/`:--:`/`:---:` → th/td textAlign；表头 td 模拟改正规 thead/th；分隔行仅前两行认定，GFM 口径）。行内增补 `~~x~~`→del、`*x*`→em（**环视断言拒 `2*3*4` 运算式误伤**：开/闭星号紧邻单词字符不匹配）；regex 重排 bold 先于 em。

### 3.2 MdTable（shared/components/MdTable.tsx）

表头点击三态排序（asc→desc→**还原原序**；localeCompare `{numeric:true, sensitivity:'base'}` 数字感知，语义照抄 change-my-life enhance.js；ES2019 稳定排序天然等价其「原始序回退」）；**行数 ≥4 附搜索筛选框**（antd Input size=small allowClear，行级过滤）；空匹配行提示；aria-sort 无障碍；`table-wrap` 横向滚动（IM 680px 卡内宽表不撑破）。

### 3.3 MdCode（shared/components/MdCode.tsx）

头行=语言标签（小写归一）+复制按钮（ExtAgentCard copied 1.5s 模式，剪贴板被拒静默）；hljs `lib/core` 模块级注册一次，`useMemo(code,lang)` 高亮，异常/未注册回退纯文本；**dangerouslySetInnerHTML 消费 hljs 转义产物=官方支持的安全用法**（hljs 对源码做 HTML 转义、仅追加自身 token span，非用户裸 HTML）；流式未闭合围栏照常渲染，每 token 重高亮单块（几 KB sub-ms，memo 隔离其余块）。

### 3.4 行内渲染共用（mdInline.tsx）

renderInline/safeHref 自 MarkdownText 抽出（MdTable 单元格复用），避免 MdTable↔MarkdownText 循环依赖。

### 3.5 hljs 主题（global.css）

自写 token 主题双版（官方 github.css 亮暗两套全局 `.hljs` 选择器冲突无法并存）：keyword 紫/字符串绿/数字橙/注释 gray-6 斜体/函数蓝/类黄/变量红，`[data-theme='dark']` 切 one-dark 系配色；**diff 整行红绿**走 `--bbc-success/-light`、`--bbc-danger/-light`（亮暗自适应 token）。

## 4. 批次划分（每批一提交一推送）

| 批 | 内容 | 提交 |
|----|------|------|
| 1 | 解析器 GFM 补齐 + 配色 token 化 | f00873b |
| 2 | MdTable 排序筛选 + MdCode 复制/高亮 + hljs 依赖分包 + 主题 | cc55a8f |
| 3 | mock 剧本第4轮收尾改富渲染样例（真机验收一眼看全）+ 本篇落稿 | （本批） |

## 5. 真机验收清单（归用户）

1. 工作台演示模式（mock）第4轮：收尾含 5 行表格——点表头三态排序（金额列数字感知升/降）、筛选框出现并可过滤、斑马纹/hover
2. bash/diff 代码块：语言标签、复制按钮（点后 1.5s 复位）、diff 整行红绿；流式期间半张表格/未闭合围栏渐进渲染不炸
3. 引用块主色竖条+淡底；任务列表勾选框（完成项灰字删除线）；~~删除线~~/*斜体*/行内码主色调
4. D27 联动：亮暗切换 + 六色 accent 切换下 h1/h2/引用/行内码/表头/hljs 主题全部跟随
5. IM 内嵌 agent 卡（680px）内宽表横向滚动不撑破；KB 阅读页长文渲染正常（D24 链接/图片不回归）

## 6. 坑与遗留登记

- **无**（本域两批 tsc/build 一次绿；hljs 官方 css 亮暗冲突是设计坑已绕开——自写主题）

## 7. 登记不做（阶段二）

- 三级以上列表嵌套拍平、`\*` 转义、`_em_` 下划线斜体（标识符误伤故只认 `*em*`）——自研解析器已知边界
- [file:] 附件卡片+灯箱（拍板 #5）
- setext 标题（`===` 下划线式）、脚注、autolink 裸链接

## 8. 对上游文档的修订清单

- PAG-03 §3.3「不引第三方渲染器」→ 收窄为「不引 **markdown 解析器**」（hljs 高亮库引入，见拍板 #2）
