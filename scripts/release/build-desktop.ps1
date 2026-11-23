# =============================================================================
# build-desktop.ps1 —— Windows 桌面发布出包（D21；与 build-desktop.sh 同口径）
#
# bbrt sidecar 随包（2026-11-23 Windows 移植后；此前「编不过不随带」决策作废）：
# 编译 x86_64-pc-windows-msvc 并按 Tauri externalBin 约定落位
# binaries/bbrt-x86_64-pc-windows-msvc.exe（与 prepare-bbrt-sidecar.sh 等价）。
#
# 用法（Windows 机器，PowerShell）：
#   $env:BBC_PUBLIC_URL = "http://bbc.example.internal"
#   $env:TAURI_SIGNING_PRIVATE_KEY = "<minisign 私钥内容或路径>"
#   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<口令>"
#   powershell -ExecutionPolicy Bypass -File scripts\release\build-desktop.ps1
#
# 产物：out\release\v<ver>\windows-x86_64\（NSIS setup.exe + .sig）
# =============================================================================
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Url = $env:BBC_PUBLIC_URL

if (-not $Url -or $Url -notmatch '^https?://[^/]+/?$') {
  Write-Error "[build-desktop] BBC_PUBLIC_URL 必填且形如 http://bbc.example.internal（不带路径）"
}
$Url = $Url.TrimEnd('/')

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  if ($env:BBC_ALLOW_UNSIGNED -eq "1") {
    Write-Warning "[build-desktop] 无签名私钥（BBC_ALLOW_UNSIGNED=1）：出包无 .sig，仅可本地试装、不可发布"
  } else {
    Write-Error "[build-desktop] 缺 TAURI_SIGNING_PRIVATE_KEY（+TAURI_SIGNING_PASSWORD）；本地试包可 BBC_ALLOW_UNSIGNED=1"
  }
}

$Conf = Get-Content "$Root\client\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $Conf.version
$Out = Join-Path $Root "out\release\v$Version\windows-x86_64"

if (-not (Test-Path "$Root\client\node_modules")) {
  Write-Error "[build-desktop] 先装依赖：cd client; npm install（勿用 npm --prefix，Windows 上 npm/cli#7722 会忽略 prefix）"
}

# 品牌产物一致性门禁（D31）：brand/brand.json 改动未跑生成器则拒绝出包
node "$Root\scripts\brand\gen.mjs" --check
if ($LASTEXITCODE -ne 0) {
  Write-Error "[build-desktop] 品牌产物 --check 未过——改 brand/ 后先 make brand-conf 再出包"
}

# ---- bbrt sidecar 编译落位（externalBin；同 prepare-bbrt-sidecar.sh 口径）----
$Triple = "x86_64-pc-windows-msvc"
$BbrtSrc = "$Root\agent\target\$Triple\release\bbrt.exe"
$BbrtDest = "$Root\client\src-tauri\binaries\bbrt-$Triple.exe"
Write-Host "[build-desktop] cargo build -p bbrt --target $Triple --release"
Push-Location "$Root\agent"
& cargo build -p bbrt --target $Triple --release
$BuildOk = $LASTEXITCODE -eq 0
Pop-Location
if (-not $BuildOk) { Write-Error "[build-desktop] bbrt sidecar 编译失败" }
if (-not (Test-Path $BbrtSrc)) { Write-Error "[build-desktop] bbrt 产物缺失: $BbrtSrc" }
$SizeMB = [math]::Round((Get-Item $BbrtSrc).Length / 1MB)
Write-Host "[build-desktop] bbrt 大小: ${SizeMB}MB（验收上限 30MB）"
if ($SizeMB -gt 30) { Write-Error "[build-desktop] bbrt 超出 16 篇 L370 验收上限" }
New-Item -ItemType Directory -Force -Path (Split-Path $BbrtDest) | Out-Null
Copy-Item $BbrtSrc $BbrtDest -Force
Write-Host "[build-desktop] sidecar 落位: $BbrtDest"

# ---- 编译期注入临时文件（finally 清理，域名不进 git）----
$EnvProd = "$Root\client\.env.production"
$RelConf = "$Root\client\src-tauri\tauri.release.conf.json"
$Insecure = if ($Url -like "http://*") { "true" } else { "false" }

@"
# build-desktop.ps1 生成（临时，勿提交）：v0.1 统一 http（D21）
VITE_API_BASE=$Url/api/v1
"@ | Set-Content -Encoding UTF8 $EnvProd

@"
{
  "plugins": {
    "updater": {
      "endpoints": ["$Url/update/latest.json"],
      "dangerousInsecureTransportProtocol": $Insecure,
      "requireSignedVersion": true
    }
  }
}
"@ | Set-Content -Encoding UTF8 $RelConf

Write-Host "[build-desktop] v$Version · 网关=$Url · insecureTransport=$Insecure"

try {
  Push-Location "$Root\client"
  & ".\node_modules\.bin\tauri.cmd" build --config $RelConf
  if ($LASTEXITCODE -ne 0) { Write-Error "[build-desktop] tauri build 失败（exit=$LASTEXITCODE）" }
} finally {
  Pop-Location
  Remove-Item $EnvProd, $RelConf -ErrorAction SilentlyContinue
}

# ---- 收集 NSIS 产物（无 --target 时落 target\release\bundle）----
$Bundle = "$Root\client\src-tauri\target\release\bundle\nsis"
if (-not (Test-Path $Bundle)) { Write-Error "[build-desktop] 找不到 NSIS 产物目录: $Bundle" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Copy-Item "$Bundle\*" $Out -Force

Write-Host ""
Write-Host "[build-desktop] 产物已收至 $Out："
Get-ChildItem $Out | ForEach-Object { Write-Host ("    {0,10:N0} KB  {1}" -f ($_.Length / 1KB), $_.Name) }
Write-Host ""
Write-Host "[build-desktop] 下一步（任一机器）：node scripts/release/gen-manifest.mjs && bash scripts/release/publish.sh"
