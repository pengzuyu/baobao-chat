//! 工作日日历本地缓存（D35）：服务端只读同步 → `schedules/calendar-<year>.json`。
//! 缓存缺失/未覆盖时回落默认规则（周一~五工作日、六日周末），与 service 口径一致。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{Datelike, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

/// 单日（wire 与服务端 /api/v1/workday-calendar 一致）
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CalendarDay {
    pub date: String, // YYYY-MM-DD
    #[serde(rename = "type")]
    pub day_type: String, // workday|weekend|holiday
    #[serde(default)]
    pub name: String,
}

/// 全年缓存
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CalendarCache {
    pub year: i32,
    #[serde(rename = "fetchedAt")]
    pub fetched_at: i64,
    pub days: Vec<CalendarDay>,
}

/// 日历缓存仓库
pub struct CalendarStore {
    dir: PathBuf,
    mem: Mutex<HashMap<i32, CalendarCache>>,
}

impl CalendarStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            mem: Mutex::new(HashMap::new()),
        }
    }

    fn path(&self, year: i32) -> PathBuf {
        self.dir.join(format!("calendar-{year}.json"))
    }

    /// 读某年缓存（内存优先）
    pub fn load(&self, year: i32) -> Option<CalendarCache> {
        if let Some(c) = self.mem.lock().unwrap().get(&year) {
            return Some(c.clone());
        }
        let raw = fs::read_to_string(self.path(year)).ok()?;
        let cache: CalendarCache = serde_json::from_str(&raw).ok()?;
        self.mem.lock().unwrap().insert(year, cache.clone());
        Some(cache)
    }

    /// 落盘 + 更新内存
    pub fn save(&self, cache: CalendarCache) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("日历目录创建失败：{e}"))?;
        let raw = serde_json::to_string_pretty(&cache).map_err(|e| e.to_string())?;
        let tmp = self.path(cache.year).with_extension("json.tmp");
        fs::write(&tmp, &raw).map_err(|e| format!("日历缓存写入失败：{e}"))?;
        fs::rename(&tmp, self.path(cache.year)).map_err(|e| format!("日历缓存落盘失败：{e}"))?;
        self.mem.lock().unwrap().insert(cache.year, cache);
        Ok(())
    }

    /// 最近同步时间（前端展示同步状态）
    pub fn status(&self) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return out;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix("calendar-") else {
                continue;
            };
            let Some(y) = rest.strip_suffix(".json") else {
                continue;
            };
            let Ok(year) = y.parse::<i32>() else {
                continue;
            };
            // 内存优先；首次读盘
            let at = self.load(year).map(|c| c.fetched_at).unwrap_or(0);
            out.push(serde_json::json!({ "year": year, "fetchedAt": at }));
        }
        out.sort_by_key(|v| v["year"].as_i64().unwrap_or(0));
        out
    }

    /// 是否工作日（缓存缺失/该日期不在缓存 → 默认规则）
    pub fn is_workday(&self, date: NaiveDate) -> bool {
        if let Some(cache) = self.load(date.year()) {
            let key = date.format("%Y-%m-%d").to_string();
            if let Some(d) = cache.days.iter().find(|d| d.date == key) {
                return d.day_type == "workday";
            }
        }
        !matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
    }

    /// 日历是否已同步该年（UI 黄条提示用）
    pub fn has_year(&self, year: i32) -> bool {
        self.load(year).is_some()
    }
}
