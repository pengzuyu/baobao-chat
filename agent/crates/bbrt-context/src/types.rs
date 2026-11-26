//! 会话轮次与工具结果数据类型（D11 §2.3 types.rs）。
//!
//! serde 统一 camelCase（嵌套 struct 自带 `rename_all`；enum variant 字段经
//! `rename_all_fields` 生效），`Round` 用 `tag = "type"` 判别，随 agent_context
//! 持久化可直接往返。轮次 token 估算口径（所有字符串字段之和）集中在本模块，
//! 供预算、组装、压缩三方共用。

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::budget::estimate_tokens;

/// 工具调用展示摘要（进入上下文的精简形态；完整 args 不回上下文）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    /// 调用 id（与工具结果轮的 call_id 对应，模型回填必需）
    pub id: String,
    /// 工具名
    pub name: String,
    /// 展示用参数摘要（如折叠后的 JSON 片段）
    pub args_digest: String,
}

/// 用户轮附件类型（与协议 `Attachment.kind` 同构）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    /// 图片（支持视觉的模型以图像形式接收）
    Image,
    /// 普通文件（只把路径告诉模型）
    File,
}

/// 用户轮附件（2026-11-26）：本机文件路径引用——与协议 `Attachment` 线上同构
/// （本 crate 不依赖 protocol；`Round` 随 agent_context 持久化直接往返）。
/// 只存元数据，不存图像字节：图像数据由 session 侧按需读盘并缓存。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// 本机绝对路径
    pub path: String,
    pub kind: AttachmentKind,
    /// 展示文件名
    pub name: String,
    /// 字节数
    #[serde(default)]
    pub size: u64,
    /// MIME（图片 png/jpeg/gif/webp；普通文件可缺省）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

impl AttachmentRef {
    /// 该附件的上下文 token 估算（路径/文件名文本行 + 图片固定估算）
    pub fn est_tokens(&self) -> usize {
        let image = if self.kind == AttachmentKind::Image {
            crate::budget::IMAGE_TOKENS
        } else {
            0
        };
        image + estimate_tokens(&self.path) + estimate_tokens(&self.name)
    }

    /// 附件清单文本行（进模型上下文的单源形态：`[Attachment: 类型] 路径（文件名）`；
    /// 英文——提示词体系已英文化，该行作为用户内容的一部分进上下文）
    pub fn context_line(&self) -> String {
        let kind = match self.kind {
            AttachmentKind::Image => "image",
            AttachmentKind::File => "file",
        };
        format!("[Attachment: {kind}] {} ({})", self.path, self.name)
    }
}

/// 一轮会话（user / assistant / tool 三态）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Round {
    /// 用户输入轮
    User {
        /// 文本内容
        content: String,
        /// 本轮附件（路径引用；空=无附件，序列化省略——旧 agent_context 行兼容）
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<AttachmentRef>,
    },
    /// 模型回复轮（可携带工具调用记录）
    Assistant {
        /// 文本内容
        content: String,
        /// 本轮发起的工具调用（展示摘要形态）
        tool_calls: Vec<ToolCallRecord>,
    },
    /// 工具执行结果轮（回填给模型的摘要形态）
    Tool {
        /// 对应的工具调用 id
        call_id: String,
        /// 工具名
        name: String,
        /// 结果摘要
        summary: String,
    },
}

impl Round {
    /// 该轮的 token 估算：所有字符串字段 `estimate_tokens` 之和
    /// （id/name 等小字段计入，协议回填时它们同样占上下文）。
    pub fn est_tokens(&self) -> usize {
        match self {
            Round::User {
                content,
                attachments,
            } => {
                estimate_tokens(content) + attachments.iter().map(|a| a.est_tokens()).sum::<usize>()
            }
            Round::Assistant {
                content,
                tool_calls,
            } => {
                estimate_tokens(content)
                    + tool_calls
                        .iter()
                        .map(|c| {
                            estimate_tokens(&c.id)
                                + estimate_tokens(&c.name)
                                + estimate_tokens(&c.args_digest)
                        })
                        .sum::<usize>()
            }
            Round::Tool {
                call_id,
                name,
                summary,
            } => estimate_tokens(call_id) + estimate_tokens(name) + estimate_tokens(summary),
        }
    }
}

/// 工具结果条目（"工具结果"区块的最小单元）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultEntry {
    /// 对应的工具调用 id
    pub call_id: String,
    /// 工具名
    pub name: String,
    /// 结果摘要文本（实际进入上下文的部分）
    pub summary: String,
    /// 该条目的 token 预估（调用方按携带体量给出；预算与软上限均以此为准，
    /// 允许大于 `estimate_tokens(summary)`，例如结果原文被折叠成摘要前的体量）
    pub est_tokens: usize,
}

/// 上下文引擎错误
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ContextError {
    /// 压缩后上下文仍超 T_ctx（D11 §5.2 error 8010 语义；
    /// est/limit 供上层回传给宿主并提示"精简任务/新建会话/更大窗口模型"）
    #[error("压缩后上下文估算 {est} tokens 仍超上限 {limit}（8010：请精简任务、新建会话或更换更大窗口模型）")]
    OverLimit {
        /// 压缩后的上下文估算
        est: usize,
        /// T_ctx 上限
        limit: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_est_tokens_含小字段() {
        // User：仅 content
        let u = Round::User {
            content: "你好abc".to_string(),
            attachments: Vec::new(),
        }; // 2 + 1 = 3
        assert_eq!(u.est_tokens(), 3);
        // Assistant：content + 每个 tool_call 的 id/name/args_digest
        let a = Round::Assistant {
            content: "abcdefgh".to_string(), // 2
            tool_calls: vec![ToolCallRecord {
                id: "call_1".to_string(),        // 2
                name: "read_file".to_string(),   // 3
                args_digest: "你好".to_string(), // 2
            }],
        };
        assert_eq!(a.est_tokens(), 2 + 2 + 3 + 2);
        // Tool：call_id + name + summary
        let t = Round::Tool {
            call_id: "call_1".to_string(),
            name: "read_file".to_string(),
            summary: "你好".to_string(),
        };
        assert_eq!(t.est_tokens(), 2 + 3 + 2);
    }

    #[test]
    fn serde_线格式_camel_case_往返() {
        let r = Round::Assistant {
            content: "你好".to_string(),
            tool_calls: vec![ToolCallRecord {
                id: "t1".to_string(),
                name: "read_file".to_string(),
                args_digest: "{...}".to_string(),
            }],
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains(r#""type":"assistant""#));
        assert!(j.contains(r#""toolCalls""#));
        assert!(j.contains(r#""argsDigest""#));
        let back: Round = serde_json::from_str(&j).unwrap();
        assert_eq!(back, r);

        let t = Round::Tool {
            call_id: "c1".to_string(),
            name: "bash".to_string(),
            summary: "ok".to_string(),
        };
        let j = serde_json::to_string(&t).unwrap();
        assert!(j.contains(r#""callId":"c1""#));
        assert_eq!(serde_json::from_str::<Round>(&j).unwrap(), t);
    }
}
