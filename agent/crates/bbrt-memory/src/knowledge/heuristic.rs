//! W2 规则触发（免模型兜底，D15 §2.2 表第 2 行）：
//!
//! - ① 用户消息命中"记住/以后/下次/别忘了…"祈使模式 → 产出候选记忆标题
//!   （= 消息首 40 字，会话结束时由上层调 `KnowledgeStore::save` 落盘）；
//! - ② 同一工具同一错误**连续 ≥2 次** → 自动产出 feedback 教训候选
//!   （正文带 **Why:** / **How to apply:** 两行，符合 D15 §2.1 feedback 格式）。
//!
//! 总开关：`memory.heuristic=off` 时全部 no-op（`Heuristic::new(false)`）。
//! 不依赖正则库（本 crate 依赖受限），触发词用包含匹配。

use super::store::MAX_TITLE_CHARS;

/// 触发词表（W2①）：任一命中即视为"请记住"类祈使
pub const HINT_PATTERNS: &[&str] = &[
    "记住",
    "以后记得",
    "以后要",
    "下次注意",
    "下次记得",
    "别忘了",
];

/// W2② 连续错误产出教训的阈值：同一 (tool, error) 连续命中 ≥2 次
pub const LESSON_STREAK_THRESHOLD: u32 = 2;

/// W2① 纯函数：消息是否携带"请记住"类祈使 → 候选标题（消息首 40 字）。
/// 空消息/未命中返回 None；标题截断与 store 的规范化口径一致。
pub fn detect_memory_hint(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || !HINT_PATTERNS.iter().any(|p| trimmed.contains(p)) {
        return None;
    }
    Some(trimmed.chars().take(MAX_TITLE_CHARS).collect())
}

/// W2② 教训候选：title 供同题更新去重，body 为 feedback 格式正文
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LessonCandidate {
    /// 候选标题（≤40 字，重复产出走同题更新不重复落盘）
    pub title: String,
    /// feedback 正文（**Why:** / **How to apply:** 两行）
    pub body: String,
}

/// 连续错误计数器（W2②）：按 (tool, error) 精确匹配计连击；
/// 该工具任一次成功即清零；其他工具的结果不影响在跟踪的连击。
#[derive(Debug, Default)]
pub struct ErrorTracker {
    /// 开关关闭时一切 no-op
    enabled: bool,
    /// 当前连击的 (tool, error)
    key: Option<(String, String)>,
    /// 连击次数
    streak: u32,
}

impl ErrorTracker {
    /// `enabled=false` 对应 `memory.heuristic=off`
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            key: None,
            streak: 0,
        }
    }

    /// 记一次工具失败：连击达到阈值（≥2）即产出 feedback 教训候选。
    /// 标题只含"工具+错误"（稳定），连击次数进正文——这样后续每次同错
    /// 失败产出的候选标题相同，落盘时走同题更新不重复（D15 §2.2）。
    pub fn record_failure(&mut self, tool: &str, error: &str) -> Option<LessonCandidate> {
        if !self.enabled {
            return None;
        }
        let key = (tool.to_string(), error.trim().to_string());
        self.streak = match &self.key {
            Some(prev) if *prev == key => self.streak + 1,
            _ => 1, // 换工具/换错误 → 重新起算
        };
        self.key = Some(key.clone());
        if self.streak < LESSON_STREAK_THRESHOLD {
            return None;
        }
        let first_line = key.1.lines().next().unwrap_or("").trim();
        let title: String = format!("工具 {} 失败：{first_line}", key.0)
            .chars()
            .take(MAX_TITLE_CHARS)
            .collect();
        Some(LessonCandidate {
            title,
            body: format!(
                "**Why:** {} 连续 {} 次返回同一错误：{first_line}\n**How to apply:** 再次调用前先核对参数与环境；仍失败则改用替代方案并请用户确认。",
                key.0, self.streak
            ),
        })
    }

    /// 记一次工具成功：打断**该工具**的错误连击（其他工具连击不受影响）
    pub fn record_success(&mut self, tool: &str) {
        if !self.enabled {
            return;
        }
        if let Some((t, _)) = &self.key {
            if t == tool {
                self.key = None;
                self.streak = 0;
            }
        }
    }
}

/// W2 门面：把开关（`memory.heuristic=off`）聚在一处，
/// 关闭时 ①② 两路全部 no-op（无候选、无内部状态推进）。
#[derive(Debug)]
pub struct Heuristic {
    enabled: bool,
    errors: ErrorTracker,
}

impl Heuristic {
    /// `enabled=false` ⇔ 配置 `memory.heuristic=off`
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            errors: ErrorTracker::new(enabled),
        }
    }

    /// 开关状态
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// W2①：候选标题（开关关闭恒 None）
    pub fn detect_memory_hint(&self, text: &str) -> Option<String> {
        if self.enabled {
            detect_memory_hint(text)
        } else {
            None
        }
    }

    /// W2②：工具失败喂入（开关关闭恒 None）
    pub fn record_tool_failure(&mut self, tool: &str, error: &str) -> Option<LessonCandidate> {
        if self.enabled {
            self.errors.record_failure(tool, error)
        } else {
            None
        }
    }

    /// W2②：工具成功喂入（开关关闭 no-op）
    pub fn record_tool_success(&mut self, tool: &str) {
        self.errors.record_success(tool);
    }
}

// ---------------------------------------------------------------------------
// 单元测试：触发词与截断口径
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_patterns_cover_d15_examples() {
        for msg in [
            "记住端口 8090",
            "以后记得先看文档",
            "下次注意别动 dist/",
            "别忘了关沙箱",
        ] {
            assert!(detect_memory_hint(msg).is_some(), "应命中: {msg}");
        }
    }

    #[test]
    fn hint_truncates_to_40_chars() {
        let long = format!("{}以后记得处理", "啰".repeat(80));
        let title = detect_memory_hint(&long).unwrap();
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
        assert!(title.starts_with("啰"));
    }
}
