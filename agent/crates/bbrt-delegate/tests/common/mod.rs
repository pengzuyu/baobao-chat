//! 集成测试共用助手：临时目录守卫、可执行 sh 桩脚本、标准简报。
//! （集成测试无法访问 crate 内 `#[cfg(test)]` 模块，此处内联同款最小实现）
//!
//! 约定：stdin 喂简报的桩（generic/zcode）需先**精确排空**简报行数再读追加输入，
//! 行数由 [`SAMPLE_BRIEF_RENDER_LINES`] 锁定（简报渲染行数变化时测试显式失败）。

// 各测试二进制按需取用子集，未用项不告警
#![allow(dead_code)]

use bbrt_protocol::TaskBrief;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 标准简报渲染后的行数（task+workspace+constraints 2+acceptance 2+forbidden 3）
pub(crate) const SAMPLE_BRIEF_RENDER_LINES: usize = 9;

/// 临时目录守卫（panic/断言失败也保证清理）
pub(crate) struct TestDir(PathBuf);

impl TestDir {
    pub(crate) fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "bbw-delegate-it-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    /// 工作区子目录（已创建）
    pub(crate) fn workspace(&self) -> PathBuf {
        let ws = self.0.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        ws
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

/// 写入可执行 sh 桩脚本，返回绝对路径字符串
pub(crate) fn write_script(dir: &Path, name: &str, body: &str) -> String {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

/// 标准测试简报（渲染行数 = [`SAMPLE_BRIEF_RENDER_LINES`]）
pub(crate) fn sample_brief(workspace: &Path) -> TaskBrief {
    TaskBrief {
        task: "给 utils/math.go 增加 Abs 函数".into(),
        workspace: workspace.display().to_string(),
        constraints: vec!["遵循现有代码风格".into()],
        context: vec![],
        acceptance: vec!["go test ./... 通过".into()],
        forbidden: vec!["修改 go.mod".into(), "修改 .github/ 目录".into()],
    }
}

/// 断言标准简报渲染行数与桩脚本排空行数一致（防简报演进后桩错位）
pub(crate) fn assert_brief_lines(brief: &TaskBrief) {
    assert_eq!(
        bbrt_delegate::render(brief).lines().count(),
        SAMPLE_BRIEF_RENDER_LINES,
        "简报渲染行数与桩脚本排空行数不一致，需同步更新桩脚本"
    );
}
