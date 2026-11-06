// 应用入口（Tauri 2 最小 main）：实际逻辑集中在 lib.rs，便于桌面/移动端复用
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    baobaowork_client_lib::run()
}
