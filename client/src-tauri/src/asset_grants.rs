//! 附件图片显示授权（2026-11-26）：assetProtocol scope 的运行时授权清单落盘。
//!
//! 背景：工作台气泡要显示本机图片缩略图（convertFileSrc→asset:// 协议）。
//! Tauri 的 asset scope 只能静态配置或经 plugin-dialog open() 自动加入——拖拽/
//! 粘贴进来的路径前者拿不到授权，且应用重启后 scope 清空（历史气泡图片全挂）。
//! 方案：壳侧维护一份授权清单（应用数据目录 JSON 落盘：全量文件级路径 +
//! 会话关联），启动时逐条加入 webview asset scope 恢复；删除会话时按关联
//! 清理。scope 只加文件级条目，不开放目录（webview 可读面=用户发过的图片
//! 原文件，面最窄）。

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// 落盘形态：{"grants":[...], "sessions":{sid:[...]}}
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Store {
    grants: BTreeSet<String>,
    sessions: HashMap<String, Vec<String>>,
}

/// 授权清单（进程级；Mutex 保护落盘读写）
pub struct AssetGrants {
    path: PathBuf,
    inner: Mutex<Store>,
}

impl AssetGrants {
    /// 装配：从应用数据目录恢复并把历史条目重新加入 webview scope
    /// （文件损坏/缺失按空清单起步；app=None 时跳过 scope 恢复——测试）
    pub fn load(app_data_dir: PathBuf, app: Option<&tauri::AppHandle>) -> Self {
        let path = app_data_dir.join("asset_grants.json");
        let inner: Store = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let grants = Self {
            path,
            inner: Mutex::new(inner),
        };
        if let Some(app) = app {
            let paths = grants.list();
            allow_scope(app, &paths);
        }
        grants
    }

    /// 会话登记一批图片（agent_input 带图时调用）：全量清单 + 会话关联落盘
    pub fn grant_session(&self, session_id: &str, paths: &[String]) {
        let mut changed = false;
        {
            let mut s = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let existing: Vec<String> = s.sessions.get(session_id).cloned().unwrap_or_default();
            let mut sess: Vec<String> = existing;
            for p in paths {
                changed |= s.grants.insert(p.clone());
                if !sess.contains(p) {
                    sess.push(p.clone());
                    changed = true;
                }
            }
            s.sessions.insert(session_id.to_string(), sess);
        }
        if changed {
            self.persist();
        }
    }

    /// 会话删除清理：从全量清单与会话关联中移除该会话登记的路径
    pub fn revoke_session(&self, session_id: &str) -> Vec<String> {
        let removed = {
            let mut s = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let Some(paths) = s.sessions.remove(session_id) else {
                return vec![];
            };
            for p in &paths {
                s.grants.remove(p);
            }
            paths
        };
        self.persist();
        removed
    }

    /// 当前全量清单（scope 恢复/测试）
    pub fn list(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .grants
            .iter()
            .cloned()
            .collect()
    }

    fn persist(&self) {
        let s = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, serde_json::to_string(&*s).unwrap_or_default()).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }
}

/// webview asset scope 追加（protocol-asset feature；窗口缺失静默跳过——测试）
pub fn allow_scope(app: &tauri::AppHandle, paths: &[String]) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let scope = win.asset_protocol_scope();
        for p in paths {
            let _ = scope.allow_file(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 登记落盘与重载恢复_会话清理() {
        let dir = std::env::temp_dir().join(format!("bbc-asset-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let grants = AssetGrants::load(dir.clone(), None);
        grants.grant_session("s1", &["/tmp/a.png".into(), "/tmp/b.png".into()]);
        grants.grant_session("s2", &["/tmp/c.png".into()]);
        grants.grant_session("s1", &["/tmp/a.png".into()]); // 幂等
        assert_eq!(grants.list().len(), 3);
        // 重载恢复
        let reloaded = AssetGrants::load(dir.clone(), None);
        assert_eq!(reloaded.list().len(), 3);
        // 删会话清理其关联
        let removed = reloaded.revoke_session("s1");
        assert_eq!(removed.len(), 2);
        assert_eq!(reloaded.list().len(), 1);
        assert!(reloaded.revoke_session("s1").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
