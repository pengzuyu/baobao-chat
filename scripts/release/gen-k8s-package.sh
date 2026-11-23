#!/usr/bin/env bash
# =============================================================================
# gen-k8s-package.sh —— K8s 部署包组装（2026-11-23；CI 与本地通用）
#
# 与 gen-deploy-package.sh（compose 档）并列：
#   compose 档 = 单 VM，栈内 pg/redis/rustfs + nginx-lb 单入口
#   K8s 档     = 集群，helm chart 管 app + deps 清单管依赖 + web 镜像做唯一入口
#
# 产物：<OUT>/baobaochat-k8s-v<ver>.tar.gz
#   ├── INSTALL-K8S.md           从零到跑通的分步操作（含预生成凭据）
#   ├── images/bbc-app-<ver>.tar.gz   服务端镜像（load 后推私服）
#   ├── images/web-<ver>.tar.gz       接入层镜像（官网+更新源+入口代理）
#   ├── chart/bbc-<chartver>.tgz      helm chart
#   ├── deps/*.yaml                   命名空间/PG/RustFS/建桶/web 入口
#   └── values-k8s.example.yaml       helm values（预填私服地址与随机凭据）
#
# 用法：
#   BBC_K8S_VERSION=0.1.4 bash scripts/release/gen-k8s-package.sh
# 环境变量：
#   BBC_K8S_VERSION   必填，版本标签（镜像 tag 与 values.imageTag）
#   BBC_REGISTRY      可选，私服前缀（默认 172.16.19.3:8182/baobaochat）
#   BBC_NODE_IP       可选，节点对外 IP 占位（默认 <NODE_IP>，部署时替换）
#   BBC_DEPLOY_OUT    可选，产物目录（默认 dist）
#
# 前置（CI/本地约定）：
#   dist/images/bbc-app-<ver>.tar.gz   服务端镜像
#   dist/images/web-<ver>.tar.gz       接入层镜像（见 deploy/k8s/baobao-chat/web-image）
#   website/dist/                       官网构建产物
#   helm 命令可用
# =============================================================================
set -euo pipefail

VER="${BBC_K8S_VERSION:?BBC_K8S_VERSION 必填（如 0.1.4）}"
REGISTRY="${BBC_REGISTRY:-172.16.19.3:8182/baobaochat}"
NODE_IP="${BBC_NODE_IP:-<NODE_IP>}"
BUNDLE="${BBC_BUNDLE_IMAGES:-0}"
OUT="${BBC_DEPLOY_OUT:-dist}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$OUT/baobaochat-k8s-v$VER"

for f in "$OUT/images/bbc-app-$VER.tar.gz" "$OUT/images/web-$VER.tar.gz"; do
  [ -f "$f" ] || { echo "[gen-k8s-package] 缺镜像包 $f" >&2; exit 1; }
done
command -v helm >/dev/null 2>&1 || { echo "[gen-k8s-package] 缺 helm 命令（打 chart 包用）" >&2; exit 1; }

rm -rf "$PKG"
mkdir -p "$PKG/images" "$PKG/chart" "$PKG/deps"

cp "$OUT/images/bbc-app-$VER.tar.gz" "$OUT/images/web-$VER.tar.gz" "$PKG/images/"

# ---- helm chart 打包 ----
helm package "$ROOT/deploy/helm/bbc" -d "$PKG/chart" >/dev/null
CHART_TGZ=$(ls "$PKG/chart"/*.tgz | head -1)
CHART_NAME=$(basename "$CHART_TGZ" .tgz)

# ---- 依赖清单（deploy/k8s/baobao-chat 的 yaml + web 入口）----
cp "$ROOT/deploy/k8s/baobao-chat/"*.yaml "$PKG/deps/"
cp "$ROOT/deploy/k8s/baobao-chat/web.yaml" "$PKG/deps/web.yaml"
# 依赖清单镜像名统一指向本次目标私服（源 yaml 里是旧 Harbor 172.16.105.109:30003/pengzuyu）
for f in "$PKG/deps/"*.yaml; do
  sed -i.bak "s|172\.16\.105\.109:30003/pengzuyu|$REGISTRY|g" "$f" && rm -f "$f.bak"
done
# 全量离线：基础镜像 tar 随包（K8s 节点不能 docker load 直用，仍需推私服一次）
if [ "$BUNDLE" = "1" ]; then
  [ -f "$OUT/images/base-images.tar.gz" ] || {
    echo "[gen-k8s-package] BBC_BUNDLE_IMAGES=1 但缺 $OUT/images/base-images.tar.gz" >&2
    exit 1
  }
  cp "$OUT/images/base-images.tar.gz" "$PKG/images/"
fi

# ---- 预生成凭据（values 与 Secret 命令同值，减少手工）----
PG_PW=$(openssl rand -hex 16)
JWT=$(openssl rand -hex 32)
KMS=$(openssl rand -base64 32)
S3AK=$(openssl rand -hex 8)
S3SK=$(openssl rand -hex 16)

cat > "$PKG/values-k8s.example.yaml" <<EOF
# BaobaoChat helm values（K8s 部署包 v$VER 预生成）
# 部署前只需确认 global.domain / externalServices.s3.publicEndpoint 里的节点 IP
global:
  domain: $NODE_IP:30808
  imageRegistry: $REGISTRY
  imageTag: $VER
  timezone: Asia/Shanghai
  imagePullSecrets: []        # 私服需登录时填 [{ name: regcred }]（见 INSTALL 步骤 1）

app:
  replicaCount: 1             # WS/presence 为进程内状态：先单副本，多实例需补事件总线
  service:
    type: ClusterIP           # 入口统一走 bbc-web（NodePort 30808），不自曝
  autoscaling:
    enabled: false
  pdb:
    enabled: false

gateway:
  enabled: false              # bbc-gateway 镜像未交付
ingress:
  enabled: false              # 裸 HTTP 形态；有 ingress controller 时可改 true 走域名

migrateJob:
  enabled: true               # 首次安装自动跑 schema 迁移（62 表）

config:
  logLevel: info
  seedDemo: "0"

externalServices:
  s3:
    endpoint: http://bbc-rustfs.baobao-chat.svc.cluster.local:9000
    publicEndpoint: http://$NODE_IP:30900
    bucket: bbc-data
    backupBucket: bbc-backup
    usePathStyle: true
  # redis 段不填：服务端代码无 Redis 依赖（2026-11-23 核实），compose 侧 redis 为历史预留

secrets:
  dbDsn: postgres://bbc:$PG_PW@bbc-pg.baobao-chat.svc.cluster.local:5432/bbc?sslmode=disable
  jwtSecret: $JWT
  kmsMasterKey: $KMS
  s3AccessKey: $S3AK
  s3SecretKey: $S3SK
EOF

# ---- INSTALL-K8S.md（分步操作，含与上面同值的 Secret 命令）----
cat > "$PKG/INSTALL-K8S.md" <<EOF
# BaobaoChat K8s 部署指南 v$VER

从零到可用共 7 步。全程在内网一台能 \`kubectl\`/\`helm\`/\`docker\` 的机器（如 master）执行。

## 0. 前置检查

\`\`\`bash
kubectl version --short | head -2      # 集群可达
helm version --short                    # helm ≥ 3.12
kubectl get storageclass                # 有默认 StorageClass（web 更新源 PVC 用）
\`\`\`

$( if [ "$BUNDLE" = "1" ]; then echo "全量离线包：依赖镜像随包提供，节点无需 registry-mirrors（仍需 insecure-registries 允许 8182 http）。"; else echo "节点需配 Docker 私服（Nexus 172.16.19.3）——每台可能调度到的节点 \`/etc/docker/daemon.json\`："; fi )

\`\`\`json
{
  "insecure-registries": ["172.16.19.3:8181", "172.16.19.3:8182"],
  "registry-mirrors": ["http://172.16.19.3:8181"]
}
\`\`\`
\`\`\`bash
systemctl daemon-reload && systemctl restart docker
\`\`\`

> 说明：app 镜像由本包 load 后推入 8182；pgvector/rustfs/aws-cli 走 8181 mirror 回源
> （首次拉取较慢，多试几次即进缓存）。

## 1. 镜像入私服

\`\`\`bash
docker load -i images/bbc-app-$VER.tar.gz
docker load -i images/web-$VER.tar.gz
docker tag baobaochat/bbc-app:$VER $REGISTRY/bbc-app:$VER
docker tag baobaochat/web:$VER     $REGISTRY/web:$VER
docker login 172.16.19.3:8182      # 凭据见公告板《私服使用手册》
docker push $REGISTRY/bbc-app:$VER
docker push $REGISTRY/web:$VER
\`\`\`

$( if [ "$BUNDLE" = "1" ]; then cat <<'BUNDLE_STEP'
**全量离线模式**：本包另含 3 个依赖镜像（pgvector/rustfs/aws-cli），一并入私服：

```bash
docker load -i images/base-images.tar.gz
docker tag pgvector/pgvector:pg16  __REG__/pgvector:pg16
docker tag rustfs/rustfs:1.0.5     __REG__/rustfs:1.0.5
docker tag amazon/aws-cli:2.31.4   __REG__/aws-cli:2.31.4
docker push __REG__/pgvector:pg16
docker push __REG__/rustfs:1.0.5
docker push __REG__/aws-cli:2.31.4
```

> deps/ 下清单的镜像名已由打包脚本替换为本包私服前缀（${REGISTRY}），无需再改。

BUNDLE_STEP
fi )
> 私服需认证时，再建拉取凭据（否则跳过）：
> \`kubectl -n baobao-chat create secret docker-registry regcred --docker-server=172.16.19.3:8182 --docker-username=*** --docker-password=***\`
> 并在 \`values-k8s.example.yaml\` 的 \`global.imagePullSecrets\` 填 \`[{ name: regcred }]\`。

## 2. 命名空间与凭据

\`\`\`bash
kubectl apply -f deps/namespace.yaml
kubectl -n baobao-chat create secret generic bbc-pg-cred \\
  --from-literal=password='$PG_PW'
kubectl -n baobao-chat create secret generic bbc-s3-cred \\
  --from-literal=accessKey='$S3AK' \\
  --from-literal=secretKey='$S3SK'
\`\`\`

> 以上三组值与 \`values-k8s.example.yaml\` 的 \`secrets\` 段一致，直接沿用即可。

## 3. 部署依赖（PG + pgvector、RustFS、建桶）

\`\`\`bash
kubectl apply -f deps/postgres.yaml
kubectl apply -f deps/rustfs.yaml
kubectl -n baobao-chat rollout status statefulset/bbc-pg --timeout=300s
kubectl -n baobao-chat rollout status deploy/bbc-rustfs --timeout=180s
kubectl apply -f deps/rustfs-init.yaml
kubectl -n baobao-chat wait --for=condition=complete job/bbc-rustfs-init --timeout=180s
\`\`\`

## 4. 安装应用（helm；自动跑迁移）

\`\`\`bash
helm install bbc chart/$CHART_NAME.tgz -n baobao-chat -f values-k8s.example.yaml
# 等 schema 迁移完成（首次 ~30-60s，62 张表）
kubectl -n baobao-chat wait --for=condition=complete \\
  job -l app.kubernetes.io/component=migrate --timeout=300s
kubectl -n baobao-chat rollout status deploy/bbc-app --timeout=300s
\`\`\`

## 5. 部署唯一入口（官网 + 更新源 + /api /ws 分流）

\`\`\`bash
sed "s|__IMAGE__|$REGISTRY/web:$VER|" deps/web.yaml | kubectl apply -f -
kubectl -n baobao-chat rollout status deploy/bbc-web --timeout=180s
\`\`\`

> 端口说明：\`bbc-web\` Service 固定 NodePort **30808**（客户端 BBC_PUBLIC_URL 的端口）。
> helm 侧 app 已设为 ClusterIP，不会抢占该端口。

## 6. 验证与首次初始化

\`\`\`bash
curl -s http://$NODE_IP:30808/healthz          # → ok
curl -s http://$NODE_IP:30808/api/v1/setup/status
\`\`\`

浏览器打开 \`http://$NODE_IP:30808/\` → 自动进 \`/setup\` 向导 → 创建首超管 →
填写 AI 供应商（如智谱 API Key）与模型 → 完成。

## 7. 发布客户端更新包（有客户端安装包时）

把 mac/CI 汇出的更新清单与安装包灌进更新源 PVC（\`/usr/share/nginx/updates\`）：

\`\`\`bash
POD=\$(kubectl -n baobao-chat get pod -l app.kubernetes.io/name=bbc-web -o jsonpath='{.items[0].metadata.name}')
kubectl -n baobao-chat cp latest.json      \$POD:/usr/share/nginx/updates/
kubectl -n baobao-chat cp release-info.json \$POD:/usr/share/nginx/updates/
kubectl -n baobao-chat cp -r releases       \$POD:/usr/share/nginx/updates/
\`\`\`

客户端安装包须用 \`BBC_PUBLIC_URL=http://$NODE_IP:30808\` 构建，
之后在关于页「检查更新」即可验证升级链。

## 升级（后续版本）

\`\`\`bash
# 新版本包内：镜像 load + push 私服（同步骤 1）后：
helm -n baobao-chat upgrade bbc chart/$CHART_NAME.tgz -f values-k8s.example.yaml \\
  --set global.imageTag=<新ver>
kubectl -n baobao-chat rollout status deploy/bbc-app
# 接入层镜像更新（官网/更新源内容变更时）
kubectl -n baobao-chat set image deploy/bbc-web web=$REGISTRY/web:<新ver>
\`\`\`

> migrateJob 是 helm hook：升级时自动重跑（迁移脚本幂等）。
> 回滚：\`helm -n baobao-chat rollback bbc\`（超出迁移窗口需恢复数据备份）。
EOF

# INSTALL 内私服前缀占位替换（BUNDLE 段用的 __REG__，此处落实际值）
sed -i.bak "s|__REG__|$REGISTRY|g" "$PKG/INSTALL-K8S.md" && rm -f "$PKG/INSTALL-K8S.md.bak"

# ---- 校验和 ----
( cd "$PKG" && find . -type f ! -name SHA256SUMS -print0 | xargs -0 sha256sum > SHA256SUMS )

# ---- 最终 tar ----
( cd "$OUT" && tar czf "baobaochat-k8s-v$VER.tar.gz" "baobaochat-k8s-v$VER" )
echo "[gen-k8s-package] 完成：$OUT/baobaochat-k8s-v$VER.tar.gz（镜像模式：$([ "$BUNDLE" = "1" ] && echo 全量离线 || echo 依赖内网 mirror)）"
( cd "$PKG" && find . -type f | sort )