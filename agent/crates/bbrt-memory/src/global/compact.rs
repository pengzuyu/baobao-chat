//! 压实漏斗（D23 §3.3 第②步，M2）：仅软条目进 LLM，硬条目程序拼回。
//!
//! - [`Compactor`] 为引擎侧 trait（bbrt-memory 不依赖模型栈——实现方
//!   `bbrt_session::FastCompactor` 接公司默认档，装配见 bbrt main）；
//! - [`compaction_prompt`] 构造压缩指令（含行格式与禁止虚构约束）；
//! - [`parse_compacted`] 解析模型输出（`[类型] 内容` 行；坏行跳过）；
//! - 压实结果的持久化由 store 侧 snapshot op 承接（`global/mod.rs` reproject：
//!   journal 只追加——snapshot 之后 replay 以其整体替换历史，兼得"永不删行"
//!   与"压实状态可持久"，journal 增长同时收敛）。

use super::{GlobalEntry, GlobalType, MAX_ENTRY_CHARS};

/// 压实器：把软条目集压缩到预算内。失败返回 Err——引擎保留旧视图
/// （宁旧勿错，D23 拍板 #4/§3.4）。
pub trait Compactor: Send + Sync {
    /// 输入=软条目（**硬条目永不进此接口**——结构性保护，D23 §3.3），
    /// `budget`=软条目渲染后字数预算（软目标 − 硬条目已占字数）。
    fn compact(&self, soft: &[GlobalEntry], budget: usize) -> Result<Vec<GlobalEntry>, String>;
}

/// 压缩指令（实现方拼 system；行格式与输出契约在此收口）
pub fn compaction_prompt(soft: &[GlobalEntry], budget: usize) -> String {
    let mut list = String::new();
    for e in soft {
        list.push_str(&format!("[{}] {}\n", e.gtype.label(), e.text));
    }
    format!(
        "把以下用户长期记忆条目压缩凝练：合并同义、剔除已过时目标、压缩措辞，\
         输出总量（含行前缀）不超过 {budget} 字。\
         规则：一行一条，格式 `[类型] 内容`（类型只能是 画像/偏好/风格/习惯/人际/术语/目标/教训，\
         禁止与授权不在此列）；单条 ≤{MAX_ENTRY_CHARS} 字；不得虚构新事实、\
         不得丢失仍然有效的语义；宁并成一条也不丢条目。\
         直接输出条目列表，不要任何解释。\n{list}"
    )
}

/// 解析压实输出：`[类型] 内容` 行 → 条目；无法解析的行静默跳过
/// （空输出由调用方按失败处理——防止把全部软条目压丢）。
pub fn parse_compacted(raw: &str) -> Vec<GlobalEntry> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        let Some((label, text)) = rest.split_once("] ") else {
            continue;
        };
        if let Some(gtype) = GlobalType::parse(label) {
            // 硬类不应出现在压实输出（输入即无）——出现即视为模型越权，丢弃该行
            if !gtype.is_hard() {
                out.push(GlobalEntry {
                    gtype,
                    text: text.trim().to_string(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_valid_lines_and_drops_hard_or_garbage() {
        let raw = "[偏好] 先结论后细节\n[教训] 越界先查沙箱\n\
                   [禁止] 我不该出现在这里\n废话一行\n[未知] x\n[] y";
        let parsed = parse_compacted(raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].gtype, GlobalType::Preference);
        assert_eq!(parsed[1].gtype, GlobalType::Lesson);
        // 压实输出的硬类行=模型越权，必须丢弃
        assert!(parsed.iter().all(|e| !e.gtype.is_hard()));
    }

    #[test]
    fn prompt_contains_contract() {
        let p = compaction_prompt(
            &[GlobalEntry {
                gtype: GlobalType::Preference,
                text: "先方案后落笔".into(),
            }],
            500,
        );
        assert!(p.contains("500"));
        assert!(p.contains("[偏好] 先方案后落笔"));
        assert!(p.contains("不得虚构"));
    }
}
