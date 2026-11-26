//! 跨模块协作冒烟（纯内存）：预算体检 → 组装 → 压缩 → 摘录 → 关键文件 map。

use bbrt_context::{
    assemble, budget_report, compact, excerpt, is_sensitive_path, AssembleParts, BudgetConfig,
    FileMap, Round, Summarizer, ToolResultEntry,
};

/// 固定小摘要的快模型 stub（生产实现为 aigw 适配层）
struct StubSummarizer;
impl Summarizer for StubSummarizer {
    fn summarize(&self, _text: &str) -> Result<String, String> {
        Ok("要点1：完成A；要点2：进行B".to_string())
    }
}

#[test]
fn 全链路_预算_组装_压缩_摘录_文件map() {
    let cfg = BudgetConfig {
        window_tokens: 10_000,
    };

    // 8 轮历史，每轮 est 500
    let history: Vec<Round> = (0..8)
        .map(|i| Round::User {
            content: format!("{}t{i}", "a".repeat(1_996)),
            attachments: Vec::new(),
        })
        .collect();
    let tool_results = [ToolResultEntry {
        call_id: "c1".to_string(),
        name: "read_file".to_string(),
        summary: "读取配置文件".to_string(),
        est_tokens: 300,
    }];

    // 1) 预算体检：4300 < 软上限 4725，不触发 compaction
    let report = budget_report(&cfg, &history, &tool_results);
    assert_eq!(report.t_ctx, 9_000);
    assert_eq!(report.soft_limit, 4_725); // 75% × (3600+2700)
    assert_eq!(report.history_est, 4_000);
    assert_eq!(report.tool_results_est, 300);
    assert!(!report.needs_compaction);

    // 2) 组装：预算内全保留（技能/项目余量让渡后历史预算 4370 ≥ 4000）
    let assembled = assemble(
        &cfg,
        AssembleParts {
            system: "sys",
            skills: "",
            project: "proj",
            memory_index: "",
            history: &history,
            tool_results: &tool_results,
        },
    );
    assert!(!assembled.truncated);
    assert_eq!(assembled.history.len(), 8);
    assert!(assembled.est_tokens <= cfg.t_ctx_tokens());

    // 3) 压缩：keep 最近 6 轮，归档段带标注
    let outcome = compact(&cfg, &history, &StubSummarizer).unwrap();
    assert_eq!(outcome.kept_rounds.len(), 6);
    assert!(outcome
        .archived_summary
        .starts_with("[已压缩摘要，原文见本地事件镜像]"));
    assert!(!outcome.degraded_to_truncation);
    assert!(outcome.freed_tokens > 0);

    // 4) 摘录：短文件全量带行号
    let ex = excerpt("l1\nl2\nl3\n", 1, 400);
    assert_eq!(ex.body, "1 l1\n2 l2\n3 l3");
    assert_eq!(ex.total_lines, 3);
    assert!(!ex.truncated);

    // 5) 敏感路径与关键文件 map（compaction 后仍在）
    assert!(is_sensitive_path(".env.local"));
    let mut fm = FileMap::new();
    fm.note("src/main.rs", "程序入口", &[1, 20]);
    let outcome2 = compact(&cfg, &history, &StubSummarizer).unwrap();
    assert_eq!(outcome2.kept_rounds.len(), 6);
    assert_eq!(fm.get("src/main.rs").unwrap().key_lines, vec![1, 20]); // map 不随压缩清除
}
