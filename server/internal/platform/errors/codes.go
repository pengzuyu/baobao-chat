// Package errors 统一业务错误码与错误类型。
// 错误码注册表：docs/14-通信协议设计.md §7（新增错误码必须先在该表登记）。
package errors

// Code 业务错误码（0=成功；分段见 14 篇 §7）
type Code int

// 0 成功
const (
	CodeOK Code = 0
)

// ───────────────────────── 1xxx 认证/令牌（03 篇） ─────────────────────────
const (
	CodeAuthPasswordWrong       Code = 1001 // 口令错误
	CodeAuthMFARequired         Code = 1002 // 需 MFA
	CodeAuthTokenExpired        Code = 1003 // token 过期
	CodeAuthTokenRevoked        Code = 1004 // token 吊销/无效
	CodeAuthDeviceLocked        Code = 1005 // 设备锁定
	CodeAuthOBOScopeExceeded    Code = 1006 // OBO scope 超出
	CodeAuthLoginLocked         Code = 1007 // 登录锁定（重试倒计时）
	CodeAuthMFACodeWrong        Code = 1008 // MFA 验证码错误
	CodeAuthMFATicketExpired    Code = 1009 // MFA 票据过期
	CodeAuthBrowserLoginExpired Code = 1010 // 浏览器登录请求过期/已使用
	CodeAuthBrowserLoginDenied  Code = 1011 // 浏览器端已拒绝
	CodeAuthConfirmMismatch     Code = 1012 // 确认码不匹配
	CodeAuthOBOKillswitch    Code = 1013 // Agent 平台总闸（killswitch：OBO 签发/网关请求拒）
	CodeAuthCodeInvalidDevice   Code = 1013 // code 已使用或非发起设备
	CodeAuthSetupDone           Code = 1014 // 系统已初始化（setup 引导已关闭）
)

// ───────────────────────── 2xxx 组织/权限/租户（03 篇） ─────────────────────────
const (
	CodePermPointDenied          Code = 2001 // 无权限点
	CodePermScopeInsufficient    Code = 2002 // 数据范围不足
	CodePermACLDenied            Code = 2003 // 资源 ACL 拒绝
	CodeTenantDisabled           Code = 2004 // 租户禁用
	CodeUserDisabled             Code = 2005 // 用户禁用
	CodeDeptHasChildrenOrMembers Code = 2006 // 部门存在子部门或成员不可删
	CodeDeptMoveCycle            Code = 2007 // 部门移动成环
)

// ───────────────────────── 3xxx IM（04 篇 §6.3） ─────────────────────────
const (
	CodeIMNotInConversation Code = 3001 // 不在会话中
	CodeIMConvDissolved     Code = 3002 // 群已解散
	CodeIMRecallTimeout     Code = 3003 // 撤回超时
	CodeIMContentTooLong    Code = 3004 // 内容超限（text ≤5000 字）
	CodeIMSensitiveBlocked  Code = 3005 // 敏感词拦截
	CodeIMMuted             Code = 3006 // 禁言中
	CodeIMRateLimited       Code = 3007 // 频率限制
	CodeIMEditWindowPassed  Code = 3008 // 编辑超窗（>5min）
	CodeIMNotMessageOwner   Code = 3009 // 无权操作该消息
	CodeIMMemberLimit       Code = 3010 // 群成员数超上限（500/5000）
	CodeIMTargetNotJoinable Code = 3011 // 目标不可加入
	CodeIMALreadyInConv     Code = 3012 // 已在会话中
	CodeIMBroadcastReadOnly Code = 3013 // 广播群只读（非 publisher）
	CodeIMMentionAllDenied  Code = 3014 // @全体被策略禁止
	CodeIMApplyInvalid      Code = 3015 // 入群申请无效/无权审批
	CodeIMOwnerCannotQuit   Code = 3016 // 群主不可退群
	CodeIMMessageNotFound   Code = 3017 // 消息不存在
	CodeIMInvalidCursor     Code = 3018 // 非法 seq/游标
	CodeIMConvNotFound      Code = 3019 // 会话不存在
	CodeIMDraftTooLong      Code = 3020 // 草稿超限
	CodeIMMergeForwardLimit Code = 3021 // 合并转发超限
	CodeIMFavoriteLimit     Code = 3022 // 收藏数量超限
	CodeIMPinnedLimit       Code = 3023 // 置顶数量超限（OQ-B06：30 个拒绝+提示）
)

// ───────────────────────── 4xxx 文件（07 篇） ─────────────────────────
const (
	CodeFileQuotaExceeded   Code = 4001 // 超配额
	CodeFileTypeForbidden   Code = 4002 // 类型禁止
	CodeFilePartCheckFailed Code = 4003 // 分片校验失败
	CodeFileVirusDetected   Code = 4004 // 病毒检测阳性
	CodeFileNotFound        Code = 4005 // 文件不存在
	CodeFileSHA256Mismatch  Code = 4006 // 整体 sha256 不一致
	CodeFilePartMissing     Code = 4007 // 分片缺失
	CodeFileUploadExpired   Code = 4008 // 上传会话过期
	CodeFileSizeLimit       Code = 4009 // 超单文件上限
	CodeFileDeleted         Code = 4013 // 文件已删除
	CodeFileTicketInvalid   Code = 4014 // 下载票据失效
	CodeFileScanning        Code = 4015 // 扫描中暂不可打开
)

// 4010-4012 分享外链错误码随文件分享移除（2026-11 产品瘦身二阶段）；
// 5xxx RTC/会议错误码段随 rtc/meeting 域整体移除（同上）。
// 编号段均保留不复用（14 篇协议废弃口径与已部署客户端兼容）。

// ───────────────────────── 6xxx 文档（06 篇） ─────────────────────────
const (
	CodeDocNoEditPerm     Code = 6001 // 无编辑权限
	CodeDocSessionFull    Code = 6002 // 协作会话已满
	CodeDocConvertFailed  Code = 6003 // 转换失败
	CodeDocVersionConflic Code = 6004 // 版本冲突
	CodeDocNotFound       Code = 6005 // 文档不存在/已入回收站
	CodeDocFormatBlocked  Code = 6006 // 格式不支持编辑
	CodeDocTooLarge       Code = 6007 // 超大小上限
	CodeDocShareInvalid   Code = 6008 // 分享失效
	CodeDocSharePwdWrong  Code = 6009 // 分享密码错误
	CodeDocTemplateOff    Code = 6010 // 模板下架
	CodeDocTrashExpired   Code = 6011 // 回收站条目过期
	CodeDocWOPITokenBad   Code = 6012 // WOPI 令牌无效
	CodeDocVersion404     Code = 6013 // 版本不存在
	CodeDocAdminLocked    Code = 6014 // 管理员锁定
	CodeDocRenameConflict Code = 6015 // 重命名冲突
	CodeDocFolderNotEmpty Code = 6016 // 文件夹非空（删除/移动目标校验）
)

// ───────────────────────── 7xxx 知识库（11 篇） ─────────────────────────
const (
	CodeKBSpaceNotFound     Code = 7001 // 空间不存在
	CodeKBQueryDenied       Code = 7002 // 无检索权限
	CodeKBIngestFailed      Code = 7003 // 摄入失败
	CodeKBQuotaExceeded     Code = 7004 // 配额超限
	CodeKBNodeNotFound      Code = 7005 // 节点不存在
	CodeKBDocTooLarge       Code = 7006 // 文档超大拒入
	CodeKBFormatUnsupported Code = 7007 // 格式不支持摄入
	CodeKBEmbeddingDown     Code = 7008 // 嵌入服务不可用
	CodeKBSensitiveDenied   Code = 7009 // 敏感文档受限
	CodeKBPersonalProtected Code = 7010 // 个人空间不可删/转让
	CodeKBGovernorInvalid   Code = 7011 // 治理者变更非法
	CodeKBRetryExhausted    Code = 7012 // 重试超限
	CodeKBSpaceArchived     Code = 7013 // 空间已归档
	CodeKBDuplicateNode     Code = 7014 // 同名节点冲突
)

// ───────────────────────── 8xxx Agent/应用（08/09/10/19 篇） ─────────────────────────
const (
	CodeAgentSessionNotFound  Code = 8001 // Agent 会话不存在
	CodeAgentToolUnauthorized Code = 8002 // 工具未授权
	CodeAgentAppDelisted      Code = 8003 // 应用已下架
	CodeAgentSignVerifyFailed Code = 8004 // 签名校验失败
	CodeAgentModelQuota       Code = 8005 // 模型配额超限
	CodeAgentPolicyDenied     Code = 8006 // 策略禁止该操作
	CodeAgentContextOverflow  Code = 8010 // compaction 后仍超限
	CodeAgentGatewayFailures  Code = 8011 // ai-gateway 连续失败
	CodeAgentReplayCorrupted  Code = 8012 // 会话重放损坏

	CodeSandboxDenied        Code = 8020 // 沙箱拒绝
	CodeSandboxCmdBlocked    Code = 8021 // 危险命令拦截
	CodeSandboxResKilled     Code = 8022 // 资源超限终止
	CodeSandboxTimeout       Code = 8023 // 超时终止
	CodeSandboxSymlinkEscape Code = 8024 // 符号链接逃逸
	CodeSandboxNetBlocked    Code = 8025 // 网络出站未白名单
	CodeSandboxFileDenied    Code = 8026 // 敏感文件拒读
	CodeAuditChainBroken     Code = 8027 // 审计哈希链断裂
	CodeKeychainDenied       Code = 8028 // 钥匙串访问被拒

	CodeDelegateBackendMissing Code = 8030 // 委派后端未安装
	CodeDelegateVersionDiff    Code = 8031 // 后端版本不符
	CodeDelegateDisabled       Code = 8032 // 后端被策略禁用
	CodeDelegateCrashed        Code = 8033 // 子进程异常退出
	CodeDelegateTimeout        Code = 8034 // 委派超时
	CodeDelegateWorkspaceBusy  Code = 8035 // 工作区被占用

	CodeEcoMinRuntime      Code = 8040 // 生态包 minRuntime 不满足
	CodeEcoPackageInvalid  Code = 8041 // 技能包结构非法
	CodeEcoCanaryMissed    Code = 8042 // 灰度未命中
	CodeEcoInstallRollback Code = 8043 // 安装失败已回滚
	CodeEcoToolConflict    Code = 8044 // 工具注册表冲突/超限
	CodeEcoDownloadBad     Code = 8045 // 包下载校验失败
	CodeEcoOfflineRevoked  Code = 8046 // 离线撤销状态过期

	CodeAIGWRatelimited       Code = 8050 // AI 网关限流
	CodeAIGWProviderDown      Code = 8051 // 供应商不可用（含熔断中）
	CodeAIGWRouteNotDefined   Code = 8052 // 路由档位未配置
	CodeAIGWProviderNotFound  Code = 8053 // 引用的供应商不存在或已停用（p: 引用解析失败）
	CodeAIGWProviderForbidden Code = 8054 // 越权引用（非公司级且非本人供应商）
	CodeAIGWModelNotAllowed   Code = 8055 // 模型不在该供应商清单内
)

// ───────────────────────── 9xxx 通用/邮件（12/22 篇） ─────────────────────────
const (
	CodeBadRequest            Code = 9001 // 参数错误
	CodeNotFound              Code = 9002 // 资源不存在
	CodeRateLimited           Code = 9003 // 限流
	CodeInternal              Code = 9004 // 服务内部错误
	CodeDependencyDown        Code = 9005 // 依赖不可用
	CodeImportFormatInvalid   Code = 9006 // 导入文件格式错误
	CodeAsyncTaskExpired      Code = 9007 // 异步任务过期
	CodeSecondFactorNeeded    Code = 9008 // 需二次验证
	CodeDualApprovalNeeded    Code = 9009 // 需双人审批
	CodeApprovalRejected      Code = 9010 // 审批被拒
	CodePlanQuotaInsufficient Code = 9011 // 套餐配额不足

	CodeMailNotReady         Code = 9020 // 邮箱未就绪
	CodeMailboxDisabled      Code = 9021 // 邮箱未开通/停用
	CodeMailProtocolError    Code = 9022 // 邮件栈协议错误
	CodeMailSendFailed       Code = 9023 // 发送失败
	CodeMailAttachmentLimit  Code = 9024 // 附件超限
	CodeMailIndexNotReady    Code = 9025 // 索引未就绪
	CodeMailAppPwdInvalid    Code = 9026 // 应用专用密码无效
	CodeMailQuotaFull        Code = 9027 // 配额满
	CodeMailFolderError      Code = 9028 // 文件夹异常
	CodeMailScheduleInvalid  Code = 9029 // 定时时间非法
	CodeMailNotFound         Code = 9030 // 邮件不存在
	CodeMailSendLimited      Code = 9031 // 发送限流
	CodeMailRecipientInvalid Code = 9032 // 收件人非法
	CodeMailICalInvalid      Code = 9033 // iCal 解析失败
	CodeMailPolicyDenied     Code = 9034 // 被策略禁止
	CodeMailDNSNotReady      Code = 9035 // 域名/DNS 未就绪
	CodeMailRelayRejected    Code = 9036 // 对外发送被中继拒绝
)
