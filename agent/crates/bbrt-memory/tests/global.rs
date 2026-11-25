//! D23 公共层（global）集成测试：journal/USER.md 两段式、更正、迁移、
//! 引擎路由、目标过期、超限语义（M1：超限保留旧视图）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bbrt_memory::{
    GlobalEntry, GlobalType, MemoryEngine, MemoryType, SaveInput, HARD_LIMIT_CHARS, MAX_ENTRY_CHARS,
};

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "bbc-mem-global-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

fn engine(tag: &str, today: &str) -> (TempDir, MemoryEngine) {
    let dir = TempDir::new(tag);
    let eng = MemoryEngine::open(
        &dir.0,
        Arc::new(bbrt_memory::FixedClock::new(
            "2026-11-12T10:00:00+08:00",
            today,
        )),
    )
    .unwrap();
    (dir, eng)
}

fn journal_lines(root: &Path) -> Vec<String> {
    fs::read_to_string(root.join("agent/memory/global/journal.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

fn view(root: &Path) -> String {
    fs::read_to_string(root.join("agent/memory/global/USER.md")).unwrap_or_default()
}

fn input(title: &str, body: &str, mtype: MemoryType) -> SaveInput {
    SaveInput {
        title: title.to_string(),
        body: body.to_string(),
        mtype,
        session: "sess-1".to_string(),
        links: vec![],
    }
}

// ---------------------------------------------------------------------------
// 基础两段式：add → journal 落一行 + USER.md 渲染；同题去重保最后
// ---------------------------------------------------------------------------

#[test]
fn add_落journal与视图_同题去重() {
    let (dir, eng) = engine("add", "2026-11-12");
    let out = eng
        .save_global(GlobalType::Preference, "先方案后落笔", "sess-1")
        .unwrap();
    assert!(!out.saved.updated);
    assert!(out.saved.global_type.as_deref() == Some("偏好"));
    assert_eq!(out.saved.scope, "user");

    // 同 type+归一文本（空白/大小写不敏感）→ updated 语义，视图仍一行
    let out2 = eng
        .save_global(GlobalType::Preference, "先 方案 后 落笔", "sess-1")
        .unwrap();
    assert!(out2.saved.updated, "归一相同应命中同题");
    assert_eq!(journal_lines(&dir.0).len(), 2, "journal 每次追加一行");
    let v = view(&dir.0);
    assert_eq!(v.matches("[偏好]").count(), 1, "去重后视图一条：{v}");
    assert!(v.contains("先 方案 后 落笔"), "保最后：{v}");
    assert!(
        v.starts_with("（USER.md 由记忆系统自动生成"),
        "视图头标注生成物"
    );
}

// ---------------------------------------------------------------------------
// 更正：forget 0/1/N 三态 + tombstone；forget 后重写同款=合法回加
// ---------------------------------------------------------------------------

#[test]
fn forget_三态与回加() {
    let (dir, eng) = engine("forget", "2026-11-12");
    // 未命中：不写 op、视图不变
    let removed = eng
        .forget_global(GlobalType::Profile, "小红", "sess-1")
        .unwrap();
    assert!(removed.is_empty());
    let before = journal_lines(&dir.0).len();

    eng.save_global(GlobalType::Profile, "用户叫小红", "sess-1")
        .unwrap();
    eng.save_global(GlobalType::Profile, "昵称是小红", "sess-1")
        .unwrap();
    eng.save_global(GlobalType::Person, "同事小红负责运维", "sess-1")
        .unwrap();
    // 命中同类两条（人际类同串不受影响——type 限定防误伤）
    let removed = eng
        .forget_global(GlobalType::Profile, "小红", "sess-1")
        .unwrap();
    assert_eq!(removed.len(), 2, "{removed:?}");
    let v = view(&dir.0);
    assert!(!v.contains("[画像]"));
    assert!(
        v.contains("[人际] 同事小红负责运维"),
        "type 限定保护人际类：{v}"
    );
    assert_eq!(
        journal_lines(&dir.0).len(),
        before + 4,
        "两次 add+一次 remove"
    );

    // forget 后重写同款=合法回加（remove 只影响其前的 add）
    eng.save_global(GlobalType::Profile, "用户叫小明", "sess-1")
        .unwrap();
    assert!(view(&dir.0).contains("[画像] 用户叫小明"));
}

// ---------------------------------------------------------------------------
// 校验拒写：单条 >80 字 / 密钥特征
// ---------------------------------------------------------------------------

#[test]
fn 单条超限与脱敏拒写() {
    let (dir, eng) = engine("reject", "2026-11-12");
    let long = "长".repeat(MAX_ENTRY_CHARS + 1);
    let err = eng
        .save_global(GlobalType::Preference, &long, "s")
        .unwrap_err();
    assert!(err.to_string().contains("80"), "{err}");
    let err = eng
        .save_global(GlobalType::Glossary, "密钥 password=hunter2", "s")
        .unwrap_err();
    assert!(err.to_string().contains("密钥特征"), "{err}");
    assert!(journal_lines(&dir.0).is_empty(), "拒写不落 journal");
}

// ---------------------------------------------------------------------------
// 超限语义（M1）：journal 永远可写；视图停在最后一次合法渲染
// ---------------------------------------------------------------------------

#[test]
fn 超限保留旧视图journal无损() {
    let (dir, eng) = engine("over", "2026-11-12");
    for i in 0..50 {
        let text = format!("事实编号 {i:02}：{}", "稳".repeat(50));
        eng.save_global(GlobalType::Profile, &text, "s").unwrap();
    }
    assert_eq!(journal_lines(&dir.0).len(), 50, "journal 全量无损");
    let v = view(&dir.0);
    assert!(
        v.chars().count() <= HARD_LIMIT_CHARS,
        "视图不得超硬顶：{}",
        v.chars().count()
    );
    assert!(eng.global().budget_left() >= 0, "视图本身 ≤ 硬顶");
}

// ---------------------------------------------------------------------------
// 目标时敏：文本内日期全过期即清（重放层，不删 journal）
// ---------------------------------------------------------------------------

#[test]
fn 目标过期自清() {
    let (dir, eng) = engine("goal", "2026-11-12");
    eng.save_global(GlobalType::Goal, "发 v0.1（2026-11-01 截止）", "s")
        .unwrap();
    eng.save_global(GlobalType::Goal, "发 v0.2（2026-12-31 截止）", "s")
        .unwrap();
    eng.save_global(GlobalType::Habit, "周报含截止日 2026-11-01", "s")
        .unwrap();
    let v = view(&dir.0);
    assert!(!v.contains("v0.1"), "过期目标应清：{v}");
    assert!(v.contains("v0.2"), "未过期目标保留：{v}");
    assert!(v.contains("周报"), "时敏只对目标类：{v}");
    assert_eq!(journal_lines(&dir.0).len(), 3, "journal 不删行");
}

// ---------------------------------------------------------------------------
// 启动 reconcile：视图被删/漂移 → 确定性重建
// ---------------------------------------------------------------------------

#[test]
fn reconcile重建视图() {
    let (dir, eng) = engine("reconcile", "2026-11-12");
    eng.save_global(GlobalType::Preference, "先方案后落笔", "s")
        .unwrap();
    let before = view(&dir.0);
    fs::remove_file(dir.0.join("agent/memory/global/USER.md")).unwrap();
    assert!(view(&dir.0).is_empty());
    eng.global().reconcile().unwrap();
    assert_eq!(view(&dir.0), before, "重建应与原渲染一致");
}

// ---------------------------------------------------------------------------
// 一次性迁移：四类映射 + project 归档不灌 + 旧文件/索引移 archive/
// ---------------------------------------------------------------------------

/// 手写旧版用户级条目文件（D15 frontmatter 格式）
fn legacy_file(root: &Path, name: &str, title: &str, mtype: &str, body: &str) {
    let md = format!(
        "---\nname: {name}\ntitle: {title}\ntype: {mtype}\n\
         created_at: 2026-11-01T10:00:00+08:00\nupdated_at: 2026-11-01T10:00:00+08:00\n\
         session: sess-old\nlinks: []\n---\n\n{body}\n"
    );
    fs::write(root.join(format!("{name}.md")), md).unwrap();
}

#[test]
fn 迁移四类映射与归档() {
    let dir = TempDir::new("migrate");
    let mem = dir.0.join("agent/memory");
    fs::create_dir_all(&mem).unwrap();
    legacy_file(&mem, "偏好简洁", "偏好简洁", "user", "回复要简洁");
    legacy_file(
        &mem,
        "端口教训",
        "端口教训",
        "feedback",
        "8080 被占用改用 8090",
    );
    legacy_file(
        &mem,
        "gitee-指针",
        "Gitee 远端",
        "reference",
        "仓库在 gitee",
    );
    legacy_file(&mem, "项目事实", "项目事实", "project", "v0.1 只做桌面端");
    fs::write(mem.join("MEMORY.md"), "- [占位](x.md) — y\n").unwrap();

    let eng = MemoryEngine::open(
        &dir.0,
        Arc::new(bbrt_memory::FixedClock::new(
            "2026-11-12T10:00:00+08:00",
            "2026-11-12",
        )),
    )
    .unwrap();

    let v = view(&dir.0);
    assert!(v.contains("[画像] 偏好简洁：回复要简洁"), "{v}");
    assert!(v.contains("[教训] 端口教训：8080 被占用改用 8090"), "{v}");
    assert!(v.contains("[术语] Gitee 远端：仓库在 gitee"), "{v}");
    assert!(!v.contains("项目事实"), "project 类不迁 global：{v}");
    // journal 三条 add；ts 保真取条目自身 updated_at
    let jl = journal_lines(&dir.0);
    assert_eq!(jl.len(), 3, "{jl:?}");
    assert!(jl.iter().all(|l| l.contains("sess-old")));
    // 根目录旧文件与索引全部移 archive/
    let archive = mem.join("archive");
    for name in [
        "偏好简洁",
        "端口教训",
        "gitee-指针",
        "项目事实",
        "MEMORY.md",
    ] {
        assert!(
            archive.join(format!("{name}.md")).exists()
                || (name == "MEMORY.md" && archive.join("MEMORY.md").exists()),
            "archive 应含 {name}"
        );
        assert!(
            !mem.join(format!("{name}.md")).exists(),
            "根目录应清空 {name}"
        );
    }
    // 幂等：二次启动零迁移
    let eng2 = MemoryEngine::open(
        &dir.0,
        Arc::new(bbrt_memory::FixedClock::new(
            "2026-11-12T11:00:00+08:00",
            "2026-11-12",
        )),
    )
    .unwrap();
    assert_eq!(journal_lines(&dir.0).len(), 3);
    assert_eq!(eng2.global().view(), eng.global().view());
    drop(eng);
}

// ---------------------------------------------------------------------------
// 引擎路由（D23 落地修订 A/B 联动）：日常回落 + user 恒公共层 + 项目分区不变
// ---------------------------------------------------------------------------

#[test]
fn 引擎路由_日常回落与user恒公共层() {
    let (dir, eng) = engine("route", "2026-11-12");
    let ws = dir.0.join("proj-a");
    fs::create_dir_all(&ws).unwrap();

    // 日常 feedback → 公共层[教训]
    let out = eng
        .save_memory_scoped(
            None,
            &input("8020 教训", "越界写被拒", MemoryType::Feedback),
        )
        .unwrap();
    assert_eq!(out.saved.scope, "user");
    assert_eq!(out.saved.global_type.as_deref(), Some("教训"));
    assert!(view(&dir.0).contains("[教训] 8020 教训"));

    // 项目会话 user 类 → 恒公共层[画像]（不落项目分区）
    let out = eng
        .save_memory_scoped(Some(&ws), &input("我是后端", "主语言 Go", MemoryType::User))
        .unwrap();
    assert_eq!(out.saved.scope, "user");
    assert!(eng.list_scoped(Some(&ws)).is_empty(), "user 类不进项目分区");

    // 项目会话 project 类 → 项目分区（D19 原口径）
    let out = eng
        .save_memory_scoped(Some(&ws), &input("端口约定", "8090", MemoryType::Project))
        .unwrap();
    assert_eq!(out.saved.scope, "project");
    assert!(out.saved.workspace_name.is_some());
    assert!(view(&dir.0).is_empty() || !view(&dir.0).contains("端口约定"));
    assert!(eng.list_scoped(Some(&ws)).len() == 1);

    // 召回：日常仅用户段（USER.md 全文）；项目两段
    let daily = eng.recall_scoped(None, "");
    assert!(daily.contains("[教训] 8020 教训"), "{daily}");
    assert!(!daily.contains("端口约定"));
    let proj = eng.recall_scoped(Some(&ws), "");
    assert!(proj.contains("[User Memory]"));
    assert!(proj.contains("[Project Memory ·"));
    assert!(proj.contains("端口约定"));
}

// ---------------------------------------------------------------------------
// M2 压实漏斗：快照持久化 + 硬条目结构性隔离 + 失败保留旧视图
// ---------------------------------------------------------------------------

/// 确定性假压实器：软条目隔条保留、每条截 20 字；记录每批输入供断言
struct FakeCompactor {
    fail: bool,
    batches: std::sync::Mutex<Vec<Vec<GlobalEntry>>>,
}

impl bbrt_memory::Compactor for FakeCompactor {
    fn compact(&self, soft: &[GlobalEntry], _budget: usize) -> Result<Vec<GlobalEntry>, String> {
        if self.fail {
            return Err("provider 不可用".to_string());
        }
        self.batches.lock().unwrap().push(soft.to_vec());
        Ok(soft
            .iter()
            .step_by(2)
            .map(|e| GlobalEntry {
                gtype: e.gtype,
                text: e.text.chars().take(20).collect(),
            })
            .collect())
    }
}

#[test]
fn 压实快照持久化_硬条目不进llm() {
    let (dir, eng) = engine("compact", "2026-11-12");
    let fake = Arc::new(FakeCompactor {
        fail: false,
        batches: std::sync::Mutex::new(vec![]),
    });
    eng.global().set_compactor(Some(fake.clone()));

    // 硬条目 2 条 + 软条目 50 条（~75 字/条 → 约 #39 越过 3000 硬顶）
    eng.save_global(GlobalType::Prohibition, "不替我直接发消息给同事", "s")
        .unwrap();
    eng.save_global(GlobalType::Grant, "测试文件直接改不用确认", "s")
        .unwrap();
    for i in 0..50 {
        eng.save_global(
            GlobalType::Profile,
            &format!("事实编号 {i:02}：{}", "稳".repeat(50)),
            "s",
        )
        .unwrap();
    }

    let v = view(&dir.0);
    assert!(
        v.chars().count() <= HARD_LIMIT_CHARS,
        "压实后 ≤ 硬顶：{}",
        v.chars().count()
    );
    // 硬条目逐字保留（程序拼回，非 LLM 复述）
    assert!(v.contains("[禁止] 不替我直接发消息给同事"), "{v}");
    assert!(v.contains("[授权] 测试文件直接改不用确认"), "{v}");

    // 结构性隔离：压实器收到的每一批都不含硬条目
    let batches = fake.batches.lock().unwrap().clone();
    assert!(!batches.is_empty(), "应至少压实一次");
    assert!(
        batches.iter().flatten().all(|e| !e.gtype.is_hard()),
        "硬条目不得进入 LLM 输入"
    );

    // 快照持久化：journal 末行 op=snapshot；此后的常规写入不再触发压实
    let jl = journal_lines(&dir.0);
    assert!(
        jl.iter().any(|l| l.contains("\"op\":\"snapshot\"")),
        "压实结果应以 snapshot op 持久化：{jl:?}"
    );
    let batches_before = fake.batches.lock().unwrap().len();
    eng.save_global(GlobalType::Preference, "先结论后细节", "s")
        .unwrap();
    assert_eq!(
        fake.batches.lock().unwrap().len(),
        batches_before,
        "快照后 replay 状态 ≤ 硬顶，常规写入走免 LLM 路径"
    );
    assert!(view(&dir.0).contains("[偏好] 先结论后细节"));
}

#[test]
fn 压实失败保留旧视图journal无损() {
    let (dir, eng) = engine("compact-fail", "2026-11-12");
    let fake = Arc::new(FakeCompactor {
        fail: true,
        batches: std::sync::Mutex::new(vec![]),
    });
    eng.global().set_compactor(Some(fake));
    for i in 0..50 {
        eng.save_global(
            GlobalType::Profile,
            &format!("事实编号 {i:02}：{}", "稳".repeat(50)),
            "s",
        )
        .unwrap();
    }
    // 宁旧勿错：视图停在最后一次合法渲染；journal 全量无损、无 snapshot
    let v = view(&dir.0);
    assert!(v.chars().count() <= HARD_LIMIT_CHARS);
    let jl = journal_lines(&dir.0);
    assert_eq!(jl.len(), 50);
    assert!(!jl.iter().any(|l| l.contains("snapshot")));
}
