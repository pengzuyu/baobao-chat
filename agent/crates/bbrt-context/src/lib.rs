//! bbrt-context：Agent Runtime 上下文引擎（D11 §5 / §2.3）。
//!
//! 职责：
//! - token 预算与估算（§5.1：T_out/T_ctx、区块分配表、软上限；CJK 1 字 ≈ 1 token、
//!   ASCII 4 字符 ≈ 1 token 的启发式估算）；
//! - 上下文组装 [`assemble`]：区块截断 + 技能/项目余量按 4:3 弹性让渡，
//!   任何区块不挤占 T_out；
//! - compaction 状态机 [`compact`]（§5.2：keep 最近 6 轮、归档段
//!   `[已压缩摘要，原文见本地事件镜像]` 标注、快模型失败退化截断、压缩后仍超
//!   T_ctx 返回 8010 语义错误）；摘要器以 [`Summarizer`] trait 注入；
//! - read_file 摘录 [`excerpt`]（§5.3：默认 400 行或 32KB 先到为准、行号前缀、
//!   offset 分页与 `[truncated, offset=X]` 标注）与敏感路径判定
//!   [`is_sensitive_path`]（默认拒读名单）；
//! - 关键文件 map [`FileMap`]（§5.4：path → 用途一句话 + 关键行号，LRU ≤64，
//!   compaction 不清除）。
//!
//! 纯逻辑 crate：零文件/网络 IO、不依赖 aigw/store（持久化与事件发射由上层
//! session/store 承担）。serde 一律 camelCase。

#![forbid(unsafe_code)]

pub mod assemble;
pub mod budget;
pub mod compaction;
pub mod excerpt;
pub mod file_map;
pub mod truncate;
pub mod types;

pub use assemble::{assemble, AssembleParts, Assembled};
pub use budget::{
    block_budgets, budget_report, estimate_tokens, BlockBudgets, BudgetConfig, BudgetReport,
    DEFAULT_WINDOW_TOKENS, IMAGE_TOKENS,
};
pub use compaction::{
    compact, CompactionOutcome, Summarizer, ARCHIVE_MAX_TOKENS, ARCHIVE_NOTE, KEEP_ROUNDS,
};
pub use excerpt::{
    excerpt, is_sensitive_path, Excerpt, DEFAULT_EXCERPT_LIMIT_LINES, DEFAULT_EXCERPT_MAX_BYTES,
};
pub use file_map::{FileMap, FileMapEntry, FILE_MAP_CAPACITY};
pub use truncate::{fit_text, fit_text_tail, TRUNCATION_MARKER};
pub use types::{
    AttachmentKind, AttachmentRef, ContextError, Round, ToolCallRecord, ToolResultEntry,
};
