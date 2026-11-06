//! 关键文件 map（D11 §5.4）。
//!
//! 工具结果中出现的路径（read/edit/search 命中）→ 一句话用途 + 关键行号；
//! LRU ≤ [`FILE_MAP_CAPACITY`]（64）条；compaction 不清除（本结构不感知压缩，
//! 由调用方随 agent_context 持久化/重建）。`get` 为只读查询不改变 LRU 顺序
//! （签名 `&self`），热度仅由 `note` 的插入/更新驱动。

use serde::{Deserialize, Serialize};

/// 容量上限（LRU ≤64 条）
pub const FILE_MAP_CAPACITY: usize = 64;

/// 单个关键文件条目
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMapEntry {
    /// 文件路径（工具结果中出现的原样路径）
    pub path: String,
    /// 一句话用途
    pub usage: String,
    /// 关键行号（定义/命中行，1 起）
    pub key_lines: Vec<usize>,
}

/// 关键文件 map（内部 Vec 末尾 = 最近使用，头部 = 最久未用）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMap {
    // 按最久→最近排序存放；serde 序列化保持此顺序，from_json 原样恢复 LRU 语义
    entries: Vec<FileMapEntry>,
}

impl FileMap {
    /// 新建空 map
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录/更新一条：已存在则更新并移到最近端；超容量淘汰最久端。
    pub fn note(&mut self, path: &str, usage: &str, key_lines: &[usize]) {
        // 同路径去重后压栈到最近端（更新即热度刷新）
        self.entries.retain(|e| e.path != path);
        self.entries.push(FileMapEntry {
            path: path.to_string(),
            usage: usage.to_string(),
            key_lines: key_lines.to_vec(),
        });
        if self.entries.len() > FILE_MAP_CAPACITY {
            let excess = self.entries.len() - FILE_MAP_CAPACITY;
            self.entries.drain(0..excess); // 淘汰最久端
        }
    }

    /// 只读查询（不改变 LRU 顺序）
    pub fn get(&self, path: &str) -> Option<&FileMapEntry> {
        self.entries.iter().find(|e| e.path == path)
    }

    /// 当前条目数（≤ [`FILE_MAP_CAPACITY`]）
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 序列化为 JSON（保持最久→最近顺序，供 agent_context 持久化）
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("FileMap 序列化不含不可序列化类型，不可失败")
    }

    /// 从 JSON 恢复（保持 LRU 顺序）；损坏输入容错返回空 map。
    pub fn from_json(json: &str) -> Self {
        serde_json::from_str(json).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_map_记录与查询() {
        let mut m = FileMap::new();
        assert!(m.is_empty());
        m.note("src/main.rs", "程序入口", &[1, 20]);
        m.note("src/lib.rs", "库根", &[3]);
        assert_eq!(m.len(), 2);
        assert_eq!(m.get("src/main.rs").unwrap().usage, "程序入口");
        assert_eq!(m.get("src/main.rs").unwrap().key_lines, vec![1, 20]);
        assert!(m.get("nope.rs").is_none());
    }

    #[test]
    fn file_map_更新同路径刷新内容与热度() {
        let mut m = FileMap::new();
        m.note("a.rs", "旧用途", &[1]);
        m.note("a.rs", "新用途", &[2, 3]); // 更新不增条数
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("a.rs").unwrap().usage, "新用途");
        assert_eq!(m.get("a.rs").unwrap().key_lines, vec![2, 3]);
    }

    #[test]
    fn file_map_65条触发lru淘汰最旧() {
        let mut m = FileMap::new();
        for i in 0..65 {
            m.note(&format!("f{i:03}.rs"), "用途", &[i]);
        }
        assert_eq!(m.len(), FILE_MAP_CAPACITY); // 64
        assert!(m.get("f000.rs").is_none()); // 最旧的 f000 被淘汰
        assert!(m.get("f001.rs").is_some());
        assert!(m.get("f064.rs").is_some()); // 最新保留
    }

    #[test]
    fn file_map_更新已有条目可使其免于淘汰() {
        let mut m = FileMap::new();
        for i in 0..64 {
            m.note(&format!("p{i:03}"), "用途", &[]);
        }
        m.note("p000", "刷新热度", &[1]); // p000 移到最近端
        m.note("p064", "新条目", &[]); // 淘汰的应是最久端 p001
        assert_eq!(m.len(), 64);
        assert!(m.get("p000").is_some(), "刷新过热度的不被淘汰");
        assert_eq!(m.get("p000").unwrap().usage, "刷新热度");
        assert!(m.get("p001").is_none(), "未刷新的最旧条目被淘汰");
        assert!(m.get("p064").is_some());
    }

    #[test]
    fn file_map_json往返保持条目与lru顺序() {
        let mut m = FileMap::new();
        m.note("a.rs", "甲", &[1]);
        m.note("b.rs", "乙", &[2, 22]);
        m.note("c.rs", "丙", &[]);
        let json = m.to_json();
        // camelCase 字段
        assert!(json.contains("keyLines"));
        let mut m2 = FileMap::from_json(&json);
        assert_eq!(m2, m); // 条目与顺序完全一致
        assert_eq!(m2.get("b.rs").unwrap().key_lines, vec![2, 22]);
        // 往返后 LRU 语义延续：再塞满淘汰的仍是最久端（a.rs）
        for i in 0..64 {
            m2.note(&format!("n{i:03}"), "新", &[]);
        }
        assert_eq!(m2.len(), 64);
        assert!(m2.get("a.rs").is_none());
        assert!(m2.get("n063").is_some());
    }

    #[test]
    fn file_map_损坏json容错为空() {
        let m = FileMap::from_json("not-a-json{");
        assert!(m.is_empty());
        assert_eq!(FileMap::from_json("{}"), FileMap::new());
    }
}
