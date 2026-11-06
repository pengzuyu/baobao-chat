//! SSE 流解析（D11 §2.7：SSE 流解析 → stream.delta）。
//!
//! 消费 `text/event-stream` 响应体，产出 [`StreamEvent`]：
//! - OpenAI 形态 chunk：`choices[0].delta.content` → [`StreamEvent::TextDelta`]；
//!   `delta.tool_calls[{index,id,function:{name,arguments}}]` →
//!   [`StreamEvent::ToolCallBegin`] / [`StreamEvent::ToolCallDelta`]；
//!   `finish_reason` 与 `usage`（可能在最后一个 chunk，也可能在独立的 usage 终帧，
//!   docs/19 §4.1-⑦）汇总为 [`StreamEvent::Done`]（缺省 usage=0）。
//! - `[DONE]` 哨兵终止；SSE 规范语义：`:` 开头注释/心跳行忽略、一个事件内多个
//!   `data:` 行以 `\n` 拼接（支持网关回传 pretty-printed JSON chunk）、其它字段
//!   （event/id/retry）忽略（前向兼容）。
//! - 事件产出后任何读失败/响应体结束但无 [DONE] 与 finish_reason →
//!   [`AigwError::StreamInterrupted`]（session 按 8011 处理，本 crate 不重放）。
//!
//! v0.1 只取 `choices[0]`（D11 stream.delta 单通道）。

use std::collections::VecDeque;
use std::io::Read;

use serde::Deserialize;

use crate::error::AigwError;
use crate::http::BodyReader;
use crate::types::{FinishReason, StreamEvent, Usage};

/// OpenAI 兼容 SSE chunk（wire 形态，snake_case 按 OpenAI 实际字段解析）。
#[derive(Debug, Deserialize)]
struct ChatChunkDto {
    #[serde(default)]
    choices: Vec<ChoiceDto>,
    /// usage 终帧可能在最后 chunk 内，也可能是独立的 usage 帧（无 choices）。
    #[serde(default)]
    usage: Option<UsageDto>,
}

#[derive(Debug, Deserialize)]
struct ChoiceDto {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    delta: Option<DeltaDto>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeltaDto {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDeltaDto>,
}

#[derive(Debug, Deserialize)]
struct ToolCallDeltaDto {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDeltaDto>,
}

#[derive(Debug, Deserialize)]
struct FunctionDeltaDto {
    #[serde(default)]
    name: Option<String>,
    /// 参数 JSON 增量（流式逐段拼接）。
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UsageDto {
    #[serde(default)]
    prompt_tokens: Option<usize>,
    #[serde(default)]
    completion_tokens: Option<usize>,
}

/// finish_reason → FinishReason（v0.1 仅这三种；未知值显式报 Protocol，不做静默映射）。
fn map_finish_reason(reason: &str) -> Result<FinishReason, AigwError> {
    match reason {
        "stop" => Ok(FinishReason::Stop),
        "tool_calls" => Ok(FinishReason::ToolCalls),
        "length" => Ok(FinishReason::Length),
        other => Err(AigwError::Protocol(format!(
            "未知 finish_reason：{other:?}"
        ))),
    }
}

/// SSE → StreamEvent 迭代器（同步阻塞，逐事件产出）。
pub(crate) struct SseEventIterator<R: Read> {
    reader: BodyReader<R>,
    /// SSE 事件累积中的 data 行。
    data_lines: Vec<String>,
    /// 同一 chunk 拆出的多个事件（如并行工具调用）先入队再逐个产出。
    pending: VecDeque<StreamEvent>,
    finish: Option<FinishReason>,
    usage: Usage,
    saw_done: bool,
    done_emitted: bool,
    finished: bool,
}

impl<R: Read> SseEventIterator<R> {
    pub(crate) fn new(reader: BodyReader<R>) -> Self {
        Self {
            reader,
            data_lines: Vec::new(),
            pending: VecDeque::new(),
            finish: None,
            usage: Usage::default(),
            saw_done: false,
            done_emitted: false,
            finished: false,
        }
    }

    /// 处理一个完整 SSE 事件的 data 载荷：解析 chunk 并更新汇总状态。
    /// 返回待产出事件（可能为空）。
    fn handle_payload(&mut self, payload: &str) -> Result<Vec<StreamEvent>, AigwError> {
        if payload == "[DONE]" {
            self.saw_done = true;
            return Ok(Vec::new());
        }
        let chunk: ChatChunkDto = serde_json::from_str(payload)
            .map_err(|e| AigwError::Serialization(format!("SSE chunk 解析失败：{e}")))?;
        let mut events = Vec::new();
        // v0.1 单 choice：只取 choices[0]
        if let Some(choice) = chunk.choices.into_iter().next() {
            let _ = choice.index; // 多 choice 场景 v0.1 不支持，index 恒按 0 处理
            if let Some(delta) = choice.delta {
                if let Some(content) = delta.content {
                    if !content.is_empty() {
                        events.push(StreamEvent::TextDelta { text: content });
                    }
                }
                for tc in delta.tool_calls {
                    let index = tc.index;
                    // 首帧带 id（一般同时带 function.name）→ Begin
                    if let Some(id) = tc.id {
                        if !id.is_empty() {
                            let name = tc
                                .function
                                .as_ref()
                                .and_then(|f| f.name.clone())
                                .unwrap_or_default();
                            events.push(StreamEvent::ToolCallBegin { index, id, name });
                        }
                    }
                    // 参数增量（首帧 arguments 可为空串则跳过）
                    if let Some(args) = tc.function.and_then(|f| f.arguments) {
                        if !args.is_empty() {
                            events.push(StreamEvent::ToolCallDelta {
                                index,
                                args_delta: args,
                            });
                        }
                    }
                }
            }
            if let Some(reason) = choice.finish_reason {
                if !reason.is_empty() && self.finish.is_none() {
                    self.finish = Some(map_finish_reason(&reason)?);
                }
            }
        }
        // usage 终帧（可能在最后 chunk，也可能是独立帧）
        if let Some(u) = chunk.usage {
            self.usage = Usage {
                prompt_tokens: u.prompt_tokens.unwrap_or(0),
                completion_tokens: u.completion_tokens.unwrap_or(0),
            };
        }
        Ok(events)
    }

    /// 收尾：[DONE] 或 body 结束时产出 Done；既无 [DONE] 也无 finish_reason 则判为断流。
    fn emit_done(&mut self) -> Option<Result<StreamEvent, AigwError>> {
        self.finished = true;
        if self.done_emitted {
            return None;
        }
        self.done_emitted = true;
        if self.saw_done || self.finish.is_some() {
            let finish = self.finish.take().unwrap_or(FinishReason::Stop);
            Some(Ok(StreamEvent::Done {
                finish,
                usage: self.usage,
            }))
        } else {
            // 响应体结束但流未正常终止（无 [DONE]、无 finish_reason）→ 断流
            Some(Err(AigwError::StreamInterrupted))
        }
    }
}

impl<R: Read> Iterator for SseEventIterator<R> {
    type Item = Result<StreamEvent, AigwError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        if let Some(ev) = self.pending.pop_front() {
            return Some(Ok(ev));
        }
        loop {
            match self.reader.read_line() {
                Ok(Some(raw)) => {
                    // 行内容含行终止符：SSE 字段解析前剥掉 \r\n（data 载荷不应包含终止符）
                    let line = raw.trim_end_matches(['\r', '\n']);
                    if line.is_empty() {
                        // 事件分隔符：分发累积的 data
                        if self.data_lines.is_empty() {
                            continue;
                        }
                        let payload = std::mem::take(&mut self.data_lines).join("\n");
                        match self.handle_payload(&payload) {
                            Ok(events) => self.pending.extend(events),
                            Err(e) => {
                                self.finished = true;
                                return Some(Err(e));
                            }
                        }
                        if self.saw_done {
                            return self.emit_done();
                        }
                        if let Some(ev) = self.pending.pop_front() {
                            return Some(Ok(ev));
                        }
                        continue;
                    }
                    if line.starts_with(':') {
                        // 注释行 / 心跳行
                        continue;
                    }
                    if let Some(rest) = line.strip_prefix("data:") {
                        // SSE 规范：冒号后仅剥一个空格
                        self.data_lines
                            .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
                    }
                    // 其余字段（event:/id:/retry:）忽略——前向兼容
                }
                Ok(None) => return self.emit_done(),
                Err(e) => {
                    self.finished = true;
                    return Some(Err(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用内存 reader：每次 read 最多 max 字节，驱动跨边界解析。
    struct ChunksReader {
        data: Vec<u8>,
        pos: usize,
        max: usize,
    }

    impl ChunksReader {
        fn new(data: &[u8], max: usize) -> Self {
            Self {
                data: data.to_vec(),
                pos: 0,
                max,
            }
        }
    }

    impl Read for ChunksReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let n = out.len().min(self.max).min(self.data.len() - self.pos);
            out[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }

    type Ev = Result<StreamEvent, AigwError>;

    /// 把一段 SSE 文本喂给迭代器（EOF body 模式），收集全部产出。
    fn run_sse(body: &str, max_read: usize) -> Vec<Ev> {
        let reader = BodyReader::new(ChunksReader::new(body.as_bytes(), max_read));
        let mut reader = reader;
        reader.set_mode(crate::http::BodyMode::Eof);
        SseEventIterator::new(reader).collect()
    }

    fn ok_events(events: Vec<Ev>) -> Vec<StreamEvent> {
        events
            .into_iter()
            .map(|e| e.expect("应为 Ok 事件"))
            .collect()
    }

    /// OpenAI 形态文本流：delta.content 增量、注释/心跳行忽略、[DONE] 终止、usage 汇总。
    #[test]
    fn parses_text_stream_with_done_and_usage() {
        let body = concat!(
            ": stream open heartbeat\n",
            "\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"你\"},\"finish_reason\":null}]}\n",
            "\n",
            "event: message\n",
            "id: 42\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\"},\"finish_reason\":null}]}\n",
            "\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7}}\n",
            "\n",
            "data: [DONE]\n",
            "\n",
        );
        for max in [1, 3, 4096] {
            let events = ok_events(run_sse(body, max));
            assert_eq!(
                events,
                vec![
                    StreamEvent::TextDelta {
                        text: "你".to_string()
                    },
                    StreamEvent::TextDelta {
                        text: "好".to_string()
                    },
                    StreamEvent::Done {
                        finish: FinishReason::Stop,
                        usage: Usage {
                            prompt_tokens: 11,
                            completion_tokens: 7
                        }
                    },
                ],
                "max_read={max}"
            );
        }
    }

    /// 工具调用流：首帧 Begin（index+id+name），后续参数增量 Delta。
    #[test]
    fn parses_tool_call_begin_and_deltas() {
        let body = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n",
            "\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"pa\"}}]},\"finish_reason\":null}]}\n",
            "\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"a.rs\\\"}\"}}]},\"finish_reason\":null}]}\n",
            "\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n",
            "\n",
            "data: [DONE]\n",
            "\n",
        );
        let events = ok_events(run_sse(body, 8));
        assert_eq!(
            events,
            vec![
                StreamEvent::ToolCallBegin {
                    index: 0,
                    id: "call-1".to_string(),
                    name: "read_file".to_string()
                },
                StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "{\"pa".to_string()
                },
                StreamEvent::ToolCallDelta {
                    index: 0,
                    args_delta: "th\":\"a.rs\"}".to_string()
                },
                StreamEvent::Done {
                    finish: FinishReason::ToolCalls,
                    usage: Usage::default()
                },
            ]
        );
    }

    /// usage 终帧独立于 finish chunk（docs/19 §4.1-⑦：结束帧后附 usage 终帧再 [DONE]）。
    #[test]
    fn usage_terminal_frame_after_finish_chunk() {
        let body = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n",
            "\n",
            "data: {\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n",
            "\n",
            "data: [DONE]\n",
            "\n",
        );
        let events = ok_events(run_sse(body, 4));
        assert_eq!(
            events,
            vec![
                StreamEvent::TextDelta {
                    text: "ok".to_string()
                },
                StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage {
                        prompt_tokens: 5,
                        completion_tokens: 2
                    }
                },
            ]
        );
    }

    /// 一个事件内多个 data: 行按 SSE 规范以 \n 拼接（pretty-printed JSON chunk）。
    #[test]
    fn multiple_data_lines_join_into_one_payload() {
        let body = concat!(
            "data: {\n",
            "data:   \"choices\": [\n",
            "data:     {\"delta\": {\"content\": \"多行\"}}\n",
            "data:   ]\n",
            "data: }\n",
            "\n",
            "data: [DONE]\n",
            "\n",
        );
        let events = ok_events(run_sse(body, 2));
        assert_eq!(
            events,
            vec![
                StreamEvent::TextDelta {
                    text: "多行".to_string()
                },
                StreamEvent::Done {
                    finish: FinishReason::Stop,
                    usage: Usage::default()
                },
            ]
        );
    }

    /// finish_reason 三种映射；未知值显式报 Protocol。
    #[test]
    fn finish_reason_mapping_and_unknown_rejected() {
        for (wire, expect) in [
            ("stop", FinishReason::Stop),
            ("tool_calls", FinishReason::ToolCalls),
            ("length", FinishReason::Length),
        ] {
            let body = format!(
                "data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"{wire}\"}}]}}\n\ndata: [DONE]\n\n"
            );
            let events = ok_events(run_sse(&body, 16));
            assert_eq!(
                events.last(),
                Some(&StreamEvent::Done {
                    finish: expect,
                    usage: Usage::default()
                })
            );
        }

        let bad = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n";
        let events = run_sse(bad, 16);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, Err(AigwError::Protocol(_)))),
            "未知 finish_reason 应报 Protocol：{events:?}"
        );
    }

    /// 非法 JSON 载荷 → Serialization；随后迭代终止。
    #[test]
    fn invalid_json_payload_is_serialization_error() {
        let events = run_sse("data: {broken\n\n", 16);
        assert!(matches!(&events[0], Err(AigwError::Serialization(_))));
    }

    /// body 结束但无 [DONE]/finish_reason（EOF 断流）→ StreamInterrupted；
    /// 已产出的增量事件保留在前面。
    #[test]
    fn eof_without_done_is_stream_interrupted() {
        let events = run_sse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"部分\"}}]}\n\n",
            16,
        );
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0],
            Ok(StreamEvent::TextDelta {
                text: "部分".to_string()
            })
        );
        assert!(matches!(&events[1], Err(AigwError::StreamInterrupted)));
        // 迭代器在错误后终止：半行残留（无 data: 前缀）不产出事件，EOF 收尾即断流错误
        let reader = BodyReader::new(ChunksReader::new(b"garbage no newline", 4));
        let mut reader = reader;
        reader.set_mode(crate::http::BodyMode::Eof);
        let mut it = SseEventIterator::new(reader);
        assert!(matches!(it.next(), Some(Err(AigwError::StreamInterrupted))));
        assert!(it.next().is_none());
    }

    /// [DONE] 缺失 finish_reason 时按 Stop 收尾（宽容），usage 缺省 0。
    #[test]
    fn done_without_finish_reason_defaults_to_stop() {
        let events = ok_events(run_sse("data: [DONE]\n\n", 16));
        assert_eq!(
            events,
            vec![StreamEvent::Done {
                finish: FinishReason::Stop,
                usage: Usage::default()
            }]
        );
    }
}
