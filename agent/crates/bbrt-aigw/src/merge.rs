//! 流事件合并（session 收尾用）：把一轮 [`StreamEvent`] 归并为 [`MergedTurn`]。
//!
//! D11 §4：stream.done 需要整轮的 finishReason 与 usage{in,out}；本函数同时拼出完整
//! assistant 文本与工具调用列表（按 index 槽位拼接 arguments 增量），供 session 落
//! 事件镜像/写回历史（assistant 消息的 tool_calls）。

use crate::types::{FinishReason, StreamEvent, ToolCallMsg, Usage};

/// 一轮流式的合并结果。
#[derive(Debug, Clone, PartialEq)]
pub struct MergedTurn {
    /// assistant 文本（全部 TextDelta 拼接）。
    pub text: String,
    /// 完整工具调用列表（按 index 升序；arguments 为增量拼接结果）。
    pub tool_calls: Vec<ToolCallMsg>,
    /// 结束原因；无 Done 事件时缺省 Stop。
    pub finish: FinishReason,
    /// token 用量；无 usage 终帧时缺省 0。
    pub usage: Usage,
}

/// 合并一轮流事件。规则：
/// - `TextDelta` 顺序拼接；
/// - `ToolCallBegin` 按 index 建槽（重复 Begin 覆盖同槽）；
/// - `ToolCallDelta` 按 index 追加 arguments（未见 Begin 的增量也保留，id/name 为空串，
///   不静默丢数据）；
/// - `Done` 覆盖 finish/usage（一般只出现一次）。
pub fn merge_stream_events(events: Vec<StreamEvent>) -> MergedTurn {
    let mut text = String::new();
    // 槽位：(id, name, arguments)
    let mut slots: Vec<(String, String, String)> = Vec::new();
    let mut finish = FinishReason::Stop;
    let mut usage = Usage::default();

    for event in events {
        match event {
            StreamEvent::TextDelta { text: delta } => text.push_str(&delta),
            // 思考增量不并入正文（merge 只收最终产物；思考增量在流式层即时外发）
            StreamEvent::ReasoningDelta { .. } => {}
            StreamEvent::ToolCallBegin { index, id, name } => {
                ensure_slot(&mut slots, index);
                slots[index] = (id, name, String::new());
            }
            StreamEvent::ToolCallDelta { index, args_delta } => {
                ensure_slot(&mut slots, index);
                slots[index].2.push_str(&args_delta);
            }
            StreamEvent::Done {
                finish: f,
                usage: u,
            } => {
                finish = f;
                usage = u;
            }
        }
    }

    MergedTurn {
        text,
        tool_calls: slots
            .into_iter()
            .map(|(id, name, arguments)| ToolCallMsg {
                id,
                name,
                arguments,
            })
            .collect(),
        finish,
        usage,
    }
}

/// 保证 index 槽位存在（不足则以空槽补齐）。
fn ensure_slot(slots: &mut Vec<(String, String, String)>, index: usize) {
    if slots.len() <= index {
        slots.resize(index + 1, (String::new(), String::new(), String::new()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 文本 + 两个工具调用的乱序（交错）增量合并、finish 映射。
    #[test]
    fn merges_interleaved_tool_call_deltas() {
        let events = vec![
            StreamEvent::TextDelta {
                text: "我来读取两个文件".to_string(),
            },
            StreamEvent::ToolCallBegin {
                index: 0,
                id: "call-a".to_string(),
                name: "read_file".to_string(),
            },
            StreamEvent::ToolCallBegin {
                index: 1,
                id: "call-b".to_string(),
                name: "read_file".to_string(),
            },
            // 两个调用的参数增量交错到达
            StreamEvent::ToolCallDelta {
                index: 1,
                args_delta: "{\"path\":".to_string(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                args_delta: "{\"path\":\"b.rs\"}".to_string(),
            },
            StreamEvent::ToolCallDelta {
                index: 1,
                args_delta: "\"a.rs\"}".to_string(),
            },
            StreamEvent::TextDelta {
                text: "，开始执行".to_string(),
            },
            StreamEvent::Done {
                finish: FinishReason::ToolCalls,
                usage: Usage {
                    prompt_tokens: 120,
                    completion_tokens: 33,
                },
            },
        ];
        let merged = merge_stream_events(events);
        assert_eq!(merged.text, "我来读取两个文件，开始执行");
        assert_eq!(merged.tool_calls.len(), 2);
        assert_eq!(
            merged.tool_calls[0],
            ToolCallMsg {
                id: "call-a".to_string(),
                name: "read_file".to_string(),
                arguments: "{\"path\":\"b.rs\"}".to_string(),
            }
        );
        assert_eq!(
            merged.tool_calls[1],
            ToolCallMsg {
                id: "call-b".to_string(),
                name: "read_file".to_string(),
                arguments: "{\"path\":\"a.rs\"}".to_string(),
            }
        );
        assert_eq!(merged.finish, FinishReason::ToolCalls);
        assert_eq!(merged.usage.prompt_tokens, 120);
        assert_eq!(merged.usage.completion_tokens, 33);
    }

    /// 未见 Begin 的参数增量：保留数据（空 id/name 槽），不静默丢弃。
    #[test]
    fn delta_without_begin_is_kept() {
        let merged = merge_stream_events(vec![
            StreamEvent::ToolCallDelta {
                index: 0,
                args_delta: "{\"x\":".to_string(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                args_delta: "1}".to_string(),
            },
        ]);
        assert_eq!(merged.tool_calls.len(), 1);
        assert_eq!(merged.tool_calls[0].id, "");
        assert_eq!(merged.tool_calls[0].arguments, "{\"x\":1}");
        assert_eq!(merged.finish, FinishReason::Stop);
        assert_eq!(merged.usage, Usage::default());
    }

    /// 空事件流 → 缺省值（Stop / 0 / 空）。
    #[test]
    fn empty_stream_merges_to_defaults() {
        let merged = merge_stream_events(vec![]);
        assert_eq!(merged.text, "");
        assert!(merged.tool_calls.is_empty());
        assert_eq!(merged.finish, FinishReason::Stop);
        assert_eq!(merged.usage, Usage::default());

        // 仅 Done：finish=Length 映射保留
        let only_done = merge_stream_events(vec![StreamEvent::Done {
            finish: FinishReason::Length,
            usage: Usage {
                prompt_tokens: 9,
                completion_tokens: 0,
            },
        }]);
        assert_eq!(only_done.finish, FinishReason::Length);
        assert_eq!(only_done.usage.prompt_tokens, 9);
    }
}
