// Tauri 构建脚本：生成上下文/能力清单校验
fn main() {
    // sidecar 生产解析需按 target-triple 找 exe 同目录 bbrt-<triple>（externalBin
    // 打包命名约定，16 篇 §5.1）；cargo 对 check/test 同样注入 TARGET
    println!(
        "cargo:rustc-env=BBW_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    tauri_build::build()
}
