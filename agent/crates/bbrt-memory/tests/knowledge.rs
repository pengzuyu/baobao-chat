//! 知识记忆集成测试（D15 §6"知识"行全表）：
//! 增/查/删；同题更新不重复（created_at 保留）；LRU 淘汰+索引重建；
//! 正文含密钥特征拒写；recall 注入截断。全部走 tempfile 临时目录。

use std::fs;
use std::sync::Arc;

use bbrt_memory::knowledge::store::INDEX_FILE;
use bbrt_memory::{
    FixedClock, KnowledgeStore, MemoryError, MemoryType, SaveInput, RECALL_FULL_ENTRIES,
    RECALL_TOP_K,
};

/// 固定时钟 + 临时记忆目录的测试脚手架
fn setup(now: &str, today: &str) -> (KnowledgeStore, Arc<FixedClock>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("临时目录");
    let clock = Arc::new(FixedClock::new(now, today));
    let store = KnowledgeStore::new(dir.path().join("memory"), clock.clone()).expect("打开存储");
    (store, clock, dir)
}

fn input(title: &str, body: &str) -> SaveInput {
    SaveInput {
        title: title.to_string(),
        mtype: MemoryType::Project,
        body: body.to_string(),
        session: "sess-1".to_string(),
        links: vec![],
    }
}

// ---------------------------------------------------------------------------
// 增 / 查 / 删
// ---------------------------------------------------------------------------

#[test]
fn save_list_get_delete_roundtrip() {
    let (store, _clock, dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    let r1 = store
        .save(&input("端口 8090 约定", "开发服务固定走 8090。"))
        .unwrap();
    let r2 = store
        .save(&input("Gitee 远端", "推送走 gitee 镜像。"))
        .unwrap();
    assert_eq!(r1.name, "端口-8090-约定");
    assert!(!r1.updated && !r2.updated);

    // 条目文件 + 索引同在（先写条目再重写索引）。
    // 同刻（固定时钟）写入的条目按 name 字典序排列（确定性输出）
    assert!(dir.path().join("memory/端口-8090-约定.md").is_file());
    let index = fs::read_to_string(dir.path().join("memory").join(INDEX_FILE)).unwrap();
    assert_eq!(
        index,
        "- [Gitee 远端](gitee-远端.md) — 推送走 gitee 镜像。\n\
         - [端口 8090 约定](端口-8090-约定.md) — 开发服务固定走 8090。\n"
    );

    // list：updated_at 新→旧（固定时钟同刻 → name 字典序）
    let list = store.list();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "gitee-远端");
    assert_eq!(list[0].hook, "推送走 gitee 镜像。");
    assert_eq!(list[0].title, "Gitee 远端");

    // get：命中与缺失
    let got = store.get("端口-8090-约定").unwrap().unwrap();
    assert_eq!(got.title, "端口 8090 约定");
    assert_eq!(got.mtype, MemoryType::Project);
    assert_eq!(got.session, "sess-1");
    assert!(store.get("不存在").unwrap().is_none());
    // 非法记忆名（路径逃逸/撞索引名）直接拒绝
    assert!(matches!(
        store.get("../etc").unwrap_err(),
        MemoryError::InvalidName(_)
    ));
    assert!(matches!(
        store.get("").unwrap_err(),
        MemoryError::InvalidName(_)
    ));

    // delete：删除条目并重写索引；再删返回 false
    assert!(store.delete("端口-8090-约定").unwrap());
    assert!(!store.delete("端口-8090-约定").unwrap());
    assert_eq!(store.list().len(), 1);
    let index = fs::read_to_string(dir.path().join("memory").join(INDEX_FILE)).unwrap();
    assert!(!index.contains("端口 8090"));
    assert!(index.contains("Gitee 远端"));
}

// ---------------------------------------------------------------------------
// 同题更新不重复（created_at 保留）
// ---------------------------------------------------------------------------

#[test]
fn same_topic_update_keeps_created_at_and_no_duplicate() {
    let (store, clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    store.save(&input("端口 8090 约定", "v1 正文")).unwrap();

    clock.set("2026-11-06T12:00:00+08:00", "2026-11-06"); // 推进时间
    let r2 = store.save(&input("端口 8090 约定", "v2 改写正文")).unwrap();
    assert!(r2.updated, "title 完全相等 → 同题更新");
    assert_eq!(store.list().len(), 1);

    let entry = store.get("端口-8090-约定").unwrap().unwrap();
    assert_eq!(
        entry.created_at, "2026-11-06T10:00:00+08:00",
        "created_at 保留"
    );
    assert_eq!(
        entry.updated_at, "2026-11-06T12:00:00+08:00",
        "updated_at 推进"
    );
    assert_eq!(entry.body, "v2 改写正文");

    // slug 相等（标题仅标点差异）也视为同题 → 原地更新而非新增
    let r3 = store
        .save(&SaveInput {
            title: "端口 8090 约定！".to_string(),
            mtype: MemoryType::User,
            body: "v3".to_string(),
            session: "sess-2".to_string(),
            links: vec!["gitee-远端".to_string()],
        })
        .unwrap();
    assert!(r3.updated);
    assert_eq!(store.list().len(), 1);
    let entry = store.get("端口-8090-约定").unwrap().unwrap();
    assert_eq!(entry.links, vec!["gitee-远端".to_string()]); // links 随更新覆盖

    // 不同标题 → 新增
    let r4 = store.save(&input("另一个事实", "x")).unwrap();
    assert!(!r4.updated);
    assert_eq!(store.list().len(), 2);
}

// ---------------------------------------------------------------------------
// 容量语义（D23 §4.2：LRU 废除——超 200 条不淘汰，否决/拍板类静默丢失=事故源）
// ---------------------------------------------------------------------------

#[test]
fn 超容量不淘汰_d23_lru废除() {
    let (store, clock, _dir) = setup("2026-11-06T08:00:00+08:00", "2026-11-06");
    let mut last = None;
    for i in 0..201 {
        clock.set(
            &format!("2026-11-06T{:02}:{:02}:00+08:00", 8 + i / 60, i % 60),
            "2026-11-06",
        );
        last = Some(
            store
                .save(&input(&format!("事实编号 {i:03}"), "b"))
                .unwrap(),
        );
    }
    assert_eq!(store.list().len(), 201, "全部保留——LRU 已废除");
    assert!(
        last.unwrap().evicted.is_empty(),
        "evicted 恒空（协议兼容位）"
    );
    assert!(store.get("事实编号-000").unwrap().is_some(), "最旧不淘汰");
    // 索引行数与条目数一致
    let index = fs::read_to_string(store.dir().join(INDEX_FILE)).unwrap();
    assert_eq!(index.lines().count(), 201);
}

// ---------------------------------------------------------------------------
// last_used 触碰（D23 §4.2：memory_read 依据——蒸馏纪律 P1）
// ---------------------------------------------------------------------------

#[test]
fn touch更新last_used且不动正文() {
    let (store, clock, _dir) = setup("2026-11-06T08:00:00+08:00", "2026-11-06");
    store.save(&input("端口约定", "开发固定 8090。")).unwrap();
    assert_eq!(
        store.get("端口约定").unwrap().unwrap().last_used,
        "",
        "新条目从未读"
    );
    clock.set("2026-11-06T12:00:00+08:00", "2026-11-06");
    assert!(store.touch("端口约定").unwrap());
    let e = store.get("端口约定").unwrap().unwrap();
    assert_eq!(e.last_used, "2026-11-06T12:00:00+08:00");
    assert_eq!(e.body, "开发固定 8090。", "正文不动");
    assert_eq!(e.updated_at, "2026-11-06T08:00:00+08:00", "updated_at 不动");
    assert!(!store.touch("不存在").unwrap(), "缺失 false");
}

#[test]
fn rebuild_index_from_directory_skips_bad_files() {
    let (store, _clock, dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    store.save(&input("好条目甲", "甲正文")).unwrap();
    store.save(&input("好条目乙", "乙正文")).unwrap();
    // 手工塞两个坏文件 + 一个陈旧索引
    let mem = dir.path().join("memory");
    fs::write(mem.join("坏文件.md"), "不是 frontmatter 格式").unwrap();
    fs::write(mem.join("半截.md"), "---\nname: 半截\ntitle: 缺闭合\n").unwrap();
    fs::write(mem.join(INDEX_FILE), "陈旧索引").unwrap();

    let outcome = store.rebuild_index().unwrap();
    assert_eq!(outcome.indexed, 2);
    assert_eq!(outcome.skipped, 2, "坏文件跳过并计数");

    let index = fs::read_to_string(mem.join(INDEX_FILE)).unwrap();
    assert!(index.contains("好条目甲") && index.contains("好条目乙"));
    assert!(!index.contains("陈旧"));
    assert_eq!(index.lines().count(), 2);
}

// ---------------------------------------------------------------------------
// 密钥特征拒写（D15 §4）
// ---------------------------------------------------------------------------

#[test]
fn save_rejects_secret_like_body_and_oversize() {
    let (store, _clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    let secrets = [
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpA..", // 私钥
        "-----BEGIN PRIVATE KEY-----\nMIIE..",       // PKCS#8
        "jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi", // JWT
        "conn?password=p@ss",                        // 口令
        "aws AKIAIOSFODNN7EXAMPLE",                  // AWS 键
    ];
    for (i, body) in secrets.iter().enumerate() {
        let err = store.save(&input(&format!("秘密 {i}"), body)).unwrap_err();
        assert!(
            matches!(err, MemoryError::SensitiveContent(_)),
            "第 {i} 例应拒写: {err}"
        );
    }
    // 命中即拒：不留任何文件与索引行（索引文件尚未生成）
    assert!(store.list().is_empty());
    assert!(!store.dir().join(INDEX_FILE).exists());

    // 正文超 4KB 拒写
    let big = "x".repeat(4 * 1024 + 1);
    assert!(matches!(
        store.save(&input("大正文", &big)).unwrap_err(),
        MemoryError::BodyTooLarge {
            actual: 4097,
            max: 4096
        }
    ));
    // 4KB 整（含多字节字符按字节计）边界可写
    let edge = "忆".repeat(2048); // 3 字节 × 2048 = 6144 > 4096 → 应拒
    assert!(matches!(
        store.save(&input("中文超限", &edge)).unwrap_err(),
        MemoryError::BodyTooLarge { .. }
    ));
    store.save(&input("正常", "ok 正文")).unwrap();
    assert_eq!(store.list().len(), 1);

    // 空标题拒写
    assert!(matches!(
        store.save(&input("   ", "x")).unwrap_err(),
        MemoryError::EmptyTitle
    ));
}

// ---------------------------------------------------------------------------
// recall 注入截断（D15 §2.3）
// ---------------------------------------------------------------------------

#[test]
fn recall_returns_full_index_under_limit() {
    let (store, _clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    assert_eq!(store.recall().unwrap(), "", "无记忆 → 空串");
    store
        .save(&input("端口 8090 约定", "开发服务固定走 8090。"))
        .unwrap();
    let recalled = store.recall().unwrap();
    assert_eq!(
        recalled,
        "- [端口 8090 约定](端口-8090-约定.md) — 开发服务固定走 8090。\n"
    );
}

#[test]
fn recall_truncates_over_200_lines_with_marker() {
    let (store, _clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    // 直接塞一份 250 行索引（模拟容量外手工场景），recall 必须截断并标注
    let long: String = (0..250)
        .map(|i| format!("- [条目 {i}](条目-{i}.md) — 钩子 {i}\n"))
        .collect();
    fs::write(store.dir().join(INDEX_FILE), long).unwrap();
    let recalled = store.recall().unwrap();
    let lines: Vec<&str> = recalled.lines().collect();
    assert_eq!(lines.len(), 201, "200 行内容 + 1 行标注");
    assert!(lines[199].starts_with("- [条目 199]"));
    assert!(lines[200].contains("已截断") && lines[200].contains("250"));
}

// ---------------------------------------------------------------------------
// recall_for Top-K 精排（D15 §2.3 关键词档）
// ---------------------------------------------------------------------------

/// 造 n 条记忆：前 n-1 条为"填充-i"，最后一条为目标条目（title/body 含关键词）
fn seed_many(store: &KnowledgeStore, clock: &FixedClock, n: usize) {
    for i in 0..n {
        // 推进时钟：填充条目越早写入 updated_at 越旧（展示序在后）
        clock.set(
            &format!("2026-11-06T10:{:02}:{:02}+08:00", i / 60 % 60, i % 60),
            "2026-11-06",
        );
        store
            .save(&input(&format!("填充条目 {i}"), "普通钩子行"))
            .unwrap();
    }
    clock.set("2026-11-06T11:00:00+08:00", "2026-11-06");
    store
        .save(&input("端口 8090 约定", "开发服务固定走 8090，勿用 8080。"))
        .unwrap();
}

#[test]
fn recall_for_full_when_entries_below_threshold() {
    let (store, _clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    store
        .save(&input("端口 8090 约定", "开发服务固定走 8090。"))
        .unwrap();
    // 条目少 → 与全量 recall 完全一致（v0.1 行为保留）
    assert_eq!(
        store.recall_for("随便问点啥").unwrap(),
        store.recall().unwrap()
    );
}

#[test]
fn recall_for_ranks_keyword_hit_first() {
    let (store, clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    seed_many(&store, &clock, RECALL_FULL_ENTRIES); // +目标条目 = 51 条 > 阈值
    let out = store.recall_for("端口 8090 被占了吗").unwrap();
    let first_line = out.lines().next().unwrap();
    assert!(
        first_line.starts_with("- [端口 8090 约定]"),
        "命中条目应排首位，实际: {first_line}"
    );
    assert!(out.lines().count() <= RECALL_TOP_K + 1, "Top-K + 尾注");
    assert!(out.contains("按与当前消息的相关度"));
}

#[test]
fn recall_for_no_hit_falls_back_to_recent_topk() {
    let (store, clock, _dir) = setup("2026-11-06T10:00:00+08:00", "2026-11-06");
    seed_many(&store, &clock, RECALL_FULL_ENTRIES);
    // 无关 query → 全零分退化为展示序（新→旧）：首条 = 最后写入的目标条目
    let out = store.recall_for("zzz qqq").unwrap();
    let first_line = out.lines().next().unwrap();
    assert!(
        first_line.starts_with("- [端口 8090 约定]"),
        "全零分应按新→旧兜底，实际: {first_line}"
    );
    // 51 条取前 50：最早写入的"填充条目 0"被截掉（按链接文件名唯一断言）
    assert!(!out.contains("填充条目-0.md"));
    assert!(out.contains("填充条目-1.md"));
}
