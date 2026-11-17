# D32 Agent 安全模式重构设计（权限矩阵放宽 + Seatbelt 退场）

- 日期：2026-11-17 ｜ 状态：**设计定稿待编码（批次 X）**
- 前置：[D13](D13-变更控制模式与沙箱执行详细设计.md)（A 模式矩阵 / B 沙箱分层）、[09 篇](../09-AI-Agent工具与安全设计.md)（§4.1 门控管线 / §4.4 处置表）、[D19](D19-Agent项目与日常对话及记忆分级详细设计.md)（沙箱按会话路由）、[D11](D11-AgentRuntime内部详细设计.md)（crate 结构）
- 动机（三件事叠加）：
  1. **确认疲劳**：「永不全自动清单」（网络出站/任意命令/git push/委派）三档永不确定，full-auto 用户仍被频繁打断——与 ZCode 实战形态（edit 档文件自动、guarded 档全自动+危险名单拦）差距集中在 matrix() 两处；
  2. **平台一致性与移植**：Seatbelt 仅 macOS；launcher.rs 全文件 unix-only（`std::os::unix`、无 cfg 门控）→ **bbrt sidecar 现编不过 Windows**，而 Windows 桌面在发布面（build-desktop.ps1）；
  3. **ZCode 对照实测**（2026-11-17 本机探针）：ZCode 当前会话 shell 无 OS 沙箱（写 HOME//tmp/工作区外全通+网络 200+无 sandbox-exec 包装）——实战纯靠权限层。宽松的权限站在沙箱/词法/checkpoint 底座上；本篇同向收敛。

## 1. 拍板点（勿重提）

| # | 决策 | 内容 |
|---|------|------|
| 1 | **矩阵放宽对齐 ZCode** | 网络出站/git push（普通）/委派 → auto-edit+ 自动；任意命令 → full-auto 自动；白名单命令 full-auto 自动（不变）；高危命令三档双确认保留；**CorpWrite 唯一保留三档确认**（效果落他人/共享面，不可撤回）+ Session 级记忆 |
| 2 | **删 Seatbelt（sandbox A 层）** | SandboxLevel/detect()/DegradedInfo/sandbox-exec profile 全退场；launcher 收缩为纯进程管理器（B 层生命周期全保留）；**词法层 C（path.rs/network.rs）保留**=矩阵底座 |
| 3 | **`BBC_SANDBOX=1` 标记保留** | procmgr 孤儿扫描依赖（bbrt-delegate/procmgr.rs:30 ENV_SANDBOX_MARK），与 Seatbelt 解耦；名字不改避免无谓 churn |
| 4 | **白名单语义收紧** | 白名单=「系统构建工具直调」专属；「执行一个文件」形态（解释器+文件参数/npm run/make 等任务运行器）与复合控制运算符形态一律不匹配 → 落 ArbitraryCommand（详见 §5） |
| 5 | **暗墙否决缓议** | 敏感路径拒读清单/内容脱敏探针/env strip 三件**不做**（理由=agent 有拿 token 去办事的正当场景；`${BBC_USER_TOKEN}` 按需注入不受影响）；已知情接受风险见 §6；方案存档 §9 备复活 |
| 6 | unknown 工具维持现状 | classify_action 未注册工具已按 ArbitraryCommand 最严档（gate.rs:199），MCP manifest 自报类别**不做**（自报不可信，unknown 统一走任意命令首次确认+记忆） |
| 7 | D13-A2 部分推翻 | 「永不全自动清单」四类中网络/git push/委派移出（CorpWrite 保留）——D13 篇与 09 篇 §4.1/§4.4 追记注记 |

## 2. 现状锚点（2026-11-17 逐行核对）

- `agent/crates/bbrt-sec/src/gate.rs`：`:25` PermissionMode（ask/auto-edit/full-auto）；`:37` ActionCategory 十类；`:146` static_category（工具名静态映射）；`:177` classify_action（run_command 三段：危险规则→白名单前缀→任意）；`:216` matrix()；`:239` confirm_scopes()；`:253` memory_allowed()（排除 DangerousCommand/CorpWrite/GitPush/Delegate）；`:264` permission_gate 六步（①租户策略→②权限点→③分类+危险拒绝→⑤untrusted→③矩阵→④三级记忆）
- `agent/crates/bbrt-sec/src/sandbox/launcher.rs`：`:23` SANDBOX_EXEC；Seatbelt（全盘只读+工作区可写+断网 profile）与 Baseline 双路径 + detect() 探测降级（DegradedInfo：命令逐次确认/网络类拒绝/模式压 auto-edit）；**B 层生命周期**=新进程组 setpgid→300s 墙钟超时→SIGINT→3s 宽限→SIGKILL 杀整组+残留补杀→输出 1MB 截断→RSS 看门狗（200ms 轮询）
- 生产接线：`bbrt-tools/src/config.rs:16/33-48`（ToolsConfig.launcher/violation_sink 可注入+StoreViolationSink）；cmd builtin 执行路径；`bbrt/src/main.rs:159`（launcher: None=构造期 detect）
- `bbrt-delegate/src/procmgr.rs:30`：ENV_SANDBOX_MARK=`BBC_SANDBOX`（孤儿扫描标记）
- `danger_rules.rs`：迷你 token 匹配语言 + 13 类内置规则——**RemoteScriptExec（curl|sh）/CredentialAccess/ForcePushProtected 已在库**，§5 只需守卫白名单匹配，不动规则库
- 其余 bbrt-sec：masking.rs（输出脱敏既有）、memory.rs（GrantStore 三级记忆）、path.rs/network.rs（词法，不动）

## 3. 矩阵终版与 gate.rs 改动明细

### 3.1 终版矩阵（改动列加粗）

| 类别 | ask | auto-edit | full-auto | 变化 |
|---|---|---|---|---|
| 只读/子agent | ✅ | ✅ | ✅ | 不变 |
| 文件编辑（含 git commit） | 🔶 | ✅ | ✅ | 不变 |
| 白名单命令 | 🔶 | 🔶 | ✅ | 不变 |
| **任意命令（含执行文件形态）** | 🔶 | 🔶 | ✅ | **三档🔶→full-auto ✅** |
| **网络出站** | 🔶 | ✅ | ✅ | **三档🔶→auto-edit+ ✅**（NetPolicy 兜底目的地） |
| **git push（普通）** | 🔶 | ✅ | ✅ | **三档🔶→auto-edit+ ✅**（force push 归危险规则） |
| **委派** | 🔶 | ✅ | ✅ | **三档🔶→auto-edit+ ✅**（子 agent 独立 checkpoint） |
| 高危命令 | 🔶双 | 🔶双 | 🔶双 | 不变 |
| unknown 工具 | 🔶 | 🔶 | 🔶 | 不变（=任意命令语义，可记忆） |
| **CorpWrite** | 🔶 | 🔶 | 🔶+Session | **永不确定→仍三档🔶**，唯一保留硬闸 |

### 3.2 函数级改动

- `matrix()`（gate.rs:216）：`ArbitraryCommand => mode == FullAuto`；`NetworkEgress | GitPush | Delegate => mode != Ask`；`DangerousCommand | CorpWrite => false`（其余不变）
- `confirm_scopes()`：CorpWrite 走 default 分支 `[Once, Session]` 已满足拍板（**Permanent 不提供**）；NetworkEgress 保持 `[Once, Session, Permanent]`；其余不变
- `memory_allowed()`：CorpWrite 从排除表移出**但仅允许 Session 粒度**——实现期核对 GrantStore.match_call 命中路径：命中 grant 为 Permanent 且 category==CorpWrite 时不豁免（防永久记忆泄漏给触人动作）；DangerousCommand/GitPush/Delegate 维持排除（GitPush/Delegate 在 auto-edit+ 走矩阵直接放行，不经过记忆；ask 档逐次确认照旧）
- `classify_action()`：白名单分支加 §5 守卫

## 4. 删 Seatbelt 改动清单（批次 X1）

**删**：SANDBOX_EXEC 常量与 profile 生成、detect()/SandboxProbe/DegradedInfo、SandboxLevel 枚举与 `sandbox_level` 徽标、sandbox-exec spawn 分支及其测试。

**留（B 层，一行不动）**：进程组 setpgid、超时链（SIGINT→3s→SIGKILL 杀组+残留补杀）、输出 1MB 截断、RSS 看门狗、RunSpec/RunOpts/ExitResult、Violation 记录与 ViolationSink（来源改为词法层越界，`StoreViolationSink` 接线不变）。

**API 策略（最小 diff）**：模块路径与类型名 `sandbox::launcher::SandboxLauncher` **保留**（语义改为「进程执行器」，本节即追记）；`detect()`/`level()` 删除，调用点改默认构造——`config.rs:33` 字段语义注释、`main.rs:159` wiring、cmd.rs 两处 SandboxLevel 引用（:481 测试）同步。

**验收**：`agent cargo test --workspace` 全绿；`rg -i "sandbox-exec|Seatbelt|SandboxLevel|DegradedInfo" agent/crates` 仅剩历史注释/文档追记零代码命中；bbrt-sec 词法层测试无回归。

## 5. 白名单语义收紧（批次 X2 之一）

白名单命中新增守卫 `is_plain_direct_invocation(cmd)`，不满足则落 ArbitraryCommand：

1. **无控制运算符**：tokenize 后不得含 `;` `&&` `||` `|` `>` `<` 反引号 `$(...)` 换行——堵「`cargo test && …`」复合绕过（prefix_match 词边界只挡了紧贴分号的形态）；
2. **非「执行一个文件」形态**：首程序 ∈ 解释器/脚本运行器（sh/bash/zsh/dash/python/python3/node/ruby/perl/php/osascript）带文件参数，或 ∈ 任务运行器（npm/pnpm/yarn/bun/make/just）——文件内容绕过词法，须按任意命令走（auto-edit+ 下 agent 本可写文件，边界在模式信任不在内容审查；`cargo test`/`go test` 等构建工具直调仍是白名单经典形态）；
3. danger_rules 不动（RemoteScriptExec 已覆盖 `curl|sh`，CredentialAccess/ForcePushProtected 在库）。

## 6. 已知情接受的风险（暗墙否决残余面，登记备查）

- **凭证外传链未设墙**：run_command 子进程继承 env（`echo $BBC_RT_TOKEN` 可得用户服务器 token）、敏感路径读（`~/.ssh`、`.env*` 等）均不拦——防线收敛为 NetPolicy 出站白名单 + 权限模式 + danger_rules 既有 CredentialAccess 类规则；
- 触发场景=prompt injection（agent 读到的内容指挥其外传凭证）；用户 2026-11-17 拍板接受（agent 有拿 token 办事的正当场景），复活路径见 §9。

## 7. UX 口径（随矩阵自然生效）

- 用户一句话：**默认 auto-edit 开箱即用；弹窗出现=这事不可逆或碰到别人**；
- 模式承诺三行：ask=没你点头改不了一个字节 / auto-edit=文件自动改（有 checkpoint 可回滚）、动作要问 / full-auto=全自动，仅危险与触人要问；
- 弹窗衰减：Session 记忆（本篇 MVP 不做 Permanent 记忆管理 UI）；
- 同任务弹窗对比（修 bug+跑测试+commit）：ask≈5 次 / auto-edit≈1 次 / full-auto=0 次。

## 8. 提交切分与验收

| # | 事项 | 改动点 | 验收 | 状态 |
|---|------|--------|------|------|
| X0 | 设计落稿 | 本篇+EXECUTION-PLAN 批次 X+detail/README 索引 | 口径可追溯 | [x] 2026-11-17 |
| X1 | 删 Seatbelt | §4 清单（launcher 收缩+接线三处+测试） | §4 验收三条 | [ ] |
| X2 | 矩阵+词法收紧 | §3.2 四函数+§5 守卫+测试新语义断言+D13/09 篇追记（拍板 7） | cargo test 全绿；文档追记可 grep | [ ] |
| X3 | 真机验收 | 三档走查：auto-edit 修 bug 全程仅跑测试 1 弹；full-auto 0 弹+高危红卡仍拦；im_send Session 记忆二问变一问 | 用户真机走查 | [ ] |

## 9. 暗墙方案存档（否决缓议，复活时直接取用）

- **判定原则=身份冒充测试**：「它漏出去，别人能不能变成我」——只收凭证不收隐私，清单小而无争议；
- **三层墙**：路径墙（path.rs 出厂清单：`~/.ssh`、`~/.aws/credentials`、`~/.kube`、`~/.netrc`、`~/.git-credentials`、shell history、浏览器 Cookies DB、工作区 `.env*`/`*.pem`/`*.key`/`id_rsa*`/`secrets/`/`credentials.json`）+ 内容墙（masking.rs 探针：PEM 头/AKIA 前缀/`ghp_`/`sk-`/`eyJ` JWT/20+ 高熵串——拦命令输出这条路）+ env 墙（spawn strip 变量名匹配 `*TOKEN*|*SECRET*|*KEY*|*PASSWORD*|*CREDENTIAL*`）；
- **个性化口子**（按理解成本）：`.bbc/sensitive` 项目声明（gitignore 语法，随 git 团队共享，推荐先做）> 内容探针自动兜 > 设置页自加（P2）；
- **拦模型不拦用户**：路径命中拒读但一次审批可翻墙（报错文案教 agent 引导用户）；内容疑似只脱敏不拦（误报率高）。

## 10. 对上游文档的修订清单

| 文档 | 修订 |
|---|---|
| D13 | 篇头追记：Part A 矩阵 A2「永不全自动清单」四类中三类移出（网络/git push/委派），CorpWrite 保留；Part B Seatbelt 全层退场（Baseline 概念随 SandboxLevel 消失，进程生命周期保留） |
| 09 篇 | §4.1 管线第 5 步「沙箱校验」描述改「进程生命周期管理（超时/杀组/截断）」；§4.4 处置表对应行追记 |
| D11 | §2.5 sandbox/ 模块描述同步（若含 Seatbelt 措辞） |
