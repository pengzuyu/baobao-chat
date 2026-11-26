//! 公共层压实器（D23 §3.3 第②步 / M2）：公司默认档凝缩（2026-11-26 单档化前固定 bbc-fast）。
//!
//! bbrt-memory 是纯存储 crate（无模型栈依赖），压实器 trait 在彼处定义、
//! 实现在此（bbrt-session 同时依赖 bbrt-memory 与 bbrt-aigw）；装配点=
//! bbrt main 在 AigwClient 构造后 `memory.set_compactor(...)`。
//! 硬条目（禁止/授权）**不经过本实现**——引擎侧结构性隔离（不进 compact 输入）。

use std::sync::Arc;

use bbrt_aigw::{ChatClient, ChatMessage, ChatRequest, StreamEvent};
use bbrt_memory::global::{parse_compacted, Compactor};
use bbrt_memory::{compaction_prompt, GlobalEntry};

/// 压实器（走公司默认档；provider 不可用=Err→引擎保留旧视图）。类型名沿用 Fast 前缀
/// （单档化后「快模型」语义已不存在，纯命名，避免跨 crate 改名扰动）
pub struct FastCompactor {
    client: Arc<dyn ChatClient>,
}

impl FastCompactor {
    /// 接入网关客户端（AigwClient 实现.ChatClient）
    pub fn new(client: Arc<dyn ChatClient>) -> Self {
        Self { client }
    }

    /// 单轮文本收集（与 loop_runner::chat_text 同形，模块内自持避免跨模块可见性放大）
    fn chat_text(&self, system: &str) -> Result<String, String> {
        let req = ChatRequest {
            model: crate::DEFAULT_MODEL_ALIAS.to_string(),
            messages: vec![
                ChatMessage {
                    role: "system".into(),
                    content: system.into(),
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "user".into(),
                    content: "开始压缩".into(),
                    tool_calls: vec![],
                    tool_call_id: None,
                },
            ],
            tools: vec![],
            thinking: None,
        };
        let mut out = String::new();
        let iter = self.client.chat(&req).map_err(|e| e.to_string())?;
        for ev in iter {
            match ev {
                Ok(StreamEvent::TextDelta { text }) => out.push_str(&text),
                Ok(_) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        if out.trim().is_empty() {
            return Err("空回复".to_string());
        }
        Ok(out)
    }
}

impl Compactor for FastCompactor {
    fn compact(&self, soft: &[GlobalEntry], budget: usize) -> Result<Vec<GlobalEntry>, String> {
        let raw = self.chat_text(&compaction_prompt(soft, budget))?;
        let parsed = parse_compacted(&raw);
        if parsed.is_empty() {
            return Err("输出无可解析条目".to_string());
        }
        Ok(parsed)
    }
}
