# baobao-chat 命名空间部署 Runbook（K8s 裸 HTTP 直连形态）

目标环境：`https://172.16.105.109:6443`（kubeconfig context `kubernetes-super-admin@kubernetes`），
镜像仓库 Harbor `172.16.105.109:30003/pengzuyu/<服务名>:<tag>`。

**形态口径**：依赖组件（PG+pgvector / RustFS）自建于 `baobao-chat` 命名空间；
app 经 NodePort `30808` 裸 HTTP 直连（桌面端 bbrt 不支持 TLS，/api /ws 同口直达）；
RustFS S3 API 经 NodePort `30900` 供预签名直传与 120s 票据下载（D25/D29）。
Helm chart（`deploy/helm/bbw`）只管 bbw-server 本体；本目录清单管依赖。

## 步骤 1：镜像转推 Harbor（bbw-app 构建 + 第三方转推）

```sh
# bbw-app（多阶段构建，builder golang:1.26-alpine；按节点架构选 --platform）
docker build --platform linux/amd64 -t 172.16.105.109:30003/pengzuyu/bbw-app:0.1.0 server/
docker push 172.16.105.109:30003/pengzuyu/bbw-app:0.1.0

# 第三方镜像转推（集群节点不便直连 Docker Hub 时统一走 Harbor）
for img in "pgvector/pgvector:pg16" "rustfs/rustfs:1.0.5" "amazon/aws-cli:2.31.4"; do
  docker pull --platform linux/amd64 "$img"
  repo="${img%%/*}"; tag="${img##*:}"
  docker tag "$img" "172.16.105.109:30003/pengzuyu/$repo:$tag"
  docker push "172.16.105.109:30003/pengzuyu/$repo:$tag"
done
```

## 步骤 2：建命名空间 + 凭据 Secret（密码不入 git）

```sh
kubectl apply -f namespace.yaml
kubectl -n baobao-chat create secret generic bbw-pg-cred  --from-literal=password="$(openssl rand -hex 16)"
kubectl -n baobao-chat create secret generic bbw-s3-cred  \
  --from-literal=accessKey="$(openssl rand -hex 8)" \
  --from-literal=secretKey="$(openssl rand -hex 16)"
```

记下这两个 Secret 的值（`kubectl -n baobao-chat get secret ... -o jsonpath`），步骤 4 要用。

## 步骤 3：部署依赖（PG + RustFS + 建桶）

```sh
kubectl apply -f postgres.yaml -f rustfs.yaml -f rustfs-init.yaml
kubectl -n baobao-chat wait --for=condition=ready pod -l app.kubernetes.io/name=bbw-pg    --timeout=300s
kubectl -n baobao-chat wait --for=condition=ready pod -l app.kubernetes.io/name=bbw-rustfs --timeout=300s
kubectl -n baobao-chat wait --for=condition=complete job/bbw-rustfs-init --timeout=300s
```

## 步骤 4：写环境实值（.local-values.yaml，已 gitignore）

```sh
cp deploy/k8s/baobao-chat/values-env.tpl.yaml deploy/helm/bbw/.local-values.yaml
# 编辑填入：PG 密码（与 bbw-pg-cred 同值）、S3 AK/SK（与 bbw-s3-cred 同值）、
#   kmsMasterKey=$(openssl rand -base64 32)、jwtSecret=$(openssl rand -hex 32)
```

## 步骤 5：helm 安装 bbw-server（含 pre-install migrate Job）

```sh
helm upgrade --install bbw deploy/helm/bbw -n baobao-chat --create-namespace \
  -f deploy/helm/bbw/.local-values.yaml
kubectl -n baobao-chat rollout status deploy/bbw-app --timeout=300s
```

## 步骤 6：冒烟 + 首管理员

```sh
curl http://172.16.105.109:30808/healthz          # 200
curl http://172.16.105.109:30808/readyz           # 200（PG ping 通）
curl http://172.16.105.109:30808/api/v1/setup/status   # 空库=未初始化态

# 首管理员（空库只能走 setup；桌面客户端连本环境即进向导，或直接）：
curl -X POST http://172.16.105.109:30808/api/v1/setup/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"employee_no":"admin","display_name":"平台管理员","password":"<密码>"}'
```

## 客户端指向

桌面端（Tauri）连接地址 = `http://172.16.105.109:30808/api/v1`（构建时 `VITE_API_BASE`
或客户端内配置）。文件 >8MB 走 RustFS 预签名直传（`172.16.105.109:30900`），<20MB 走服务端中转。

## 常见处置

- **migrate Job 失败**：`kubectl -n baobao-chat logs job/bbw-migrate`；基线 0001 需 pgvector
  扩展（镜像非 pgvector 版必失败）。
- **镜像拉取失败**：确认 Harbor 登录（`docker login 172.16.105.109:30003`）与节点 containerd
  对该 registry 的信任配置。
- **S3 凭据轮换**：改 `bbw-s3-cred` Secret + `.local-values.yaml` → 重跑 rustfs-init Job →
  `helm upgrade`。
- **数据备份**：PG 卷 PVC `bbw-pg-data`；对象存储卷 `bbw-rustfs-data`（bbw-backup 桶）。
