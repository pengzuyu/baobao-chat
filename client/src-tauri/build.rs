// Tauri 构建脚本：生成上下文/能力清单校验
fn main() {
    // sidecar 生产解析需按 target-triple 找 exe 同目录 bbrt-<triple>（externalBin
    // 打包命名约定，16 篇 §5.1）；cargo 对 check/test 同样注入 TARGET
    println!(
        "cargo:rustc-env=BBC_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    // 发布打包注入（D21）：BBC_PUBLIC_URL（如 http://bbc.example.internal）作为
    // bbrt 网关的编译期缺省——打包应用无进程 env 可设，两级缺省链见 agent_bridge。
    // 本地 dev 不设此变量即回落 127.0.0.1:8090（联调语义不变）。
    println!("cargo:rerun-if-env-changed=BBC_PUBLIC_URL");
    if let Ok(url) = std::env::var("BBC_PUBLIC_URL") {
        if !url.is_empty() {
            println!("cargo:rustc-env=BBC_DEFAULT_GATEWAY={url}");
        }
    }
    tauri_build::build()
}
