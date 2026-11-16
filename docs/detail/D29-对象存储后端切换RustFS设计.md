# D29 对象存储后端切换 RustFS 设计（MinIO 移除）

- 日期：2026-11-16 ｜ 状态：设计定稿（选型拍板），批次 R 开工
- 前置：D25（对象存储与预签名直传）、deploy/compose（minio 容器+minio-init+nginx `/oss/`）、01 篇 A.2（License 留意项预登记）
- 动机（双风险，2026-11-16 会话裁决移除 MinIO）：
  1. **License**：MinIO 社区版 AGPL-3.0，网络条款（§13）触发公司合规一刀切禁入风险（01 篇 A.2 预登记项正式触发处理）；
  2. **上游死亡**：MinIO 开源版 2025-09 宣布 EOL、2026-02-12 仓库归档不再收任何变更；compose 钉死 `RELEASE.2024-11-07` 从此**永无安全补丁**。

## 1. 拍板点（勿重提）

| # | 决策 | 内容 |
|---|------|------|
| 1 | 后端选型 | **RustFS**（Rust 重写 MinIO 替身，Apache-2.0；S3 兼容矩阵以 Ceph s3tests 套件实测背书；桶版本化/预签名/CORS 全支持）。SeaweedFS 落选——**桶版本化不完整是结构性缺口**（versionId/ListObjectVersions），且多组件部署面大；Garage/Silo 分叉仍 AGPL 排除；Ceph/Ozone 与单节点 2TB 档不匹配 |
| 2 | 服务/卷改名 | compose 服务 `minio`→`rustfs`、init 容器 `minio-init`→`rustfs-init`、卷 `minio-data`→`rustfs-data`、脚本 `migrate-files-to-minio.sh`→`migrate-files-to-s3.sh`（AGPL 措辞一并清零） |
| 3 | init 工具 | `mc`（同为 AGPL）退役 → **amazon/aws-cli:2.31.4**（Apache-2.0）；桶创建/版本化/CORS 全走标准 S3 API（`create-bucket`/`put-bucket-versioning`/`put-bucket-cors`） |
| 4 | 凭据键名 | `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`（规范名；`MINIO_ROOT_*` 兼容别名已弃用不用）。默认凭据 `rustfsadmin` 公开已知=必须显式设置 |
| 5 | Go/前端零协议改动 | D25 拍板 aws-sdk-go-v2 的红利兑现：服务端无任何 MinIO 私有 API、客户端用服务端下发的绝对 URL——**仅 main.go 日志文案**；换后端=换镜像+endpoint |
| 6 | 兼容性验证 | `BBW_TEST_S3_ADDR` 门控集成测试落地（清偿 D25 §10「门控单测未落」遗留）+ 本地冒烟；真机全链并入 D25 §9 六项 |

## 2. 候选对照（决策依据存档）

| 候选 | 协议 | 预签名 multipart | 桶版本化 | 形态 | 结论 |
|---|---|---|---|---|---|
| MinIO 社区版 | AGPL-3.0 | ✅ | ✅ | 单进程 | **移除**（AGPL+归档无补丁） |
| **RustFS 1.0.5** | Apache-2.0 | ✅（presigned GET/PUT 过 s3tests） | ✅ | 单进程 9000/9001 | **采用**（GA 2026-09-16，较新以「S3 协议出口+内容寻址可 rclone 再搬」对冲） |
| SeaweedFS | Apache-2.0 | ⚠️ 基础支持需实测 | ❌ 不完整 | master+volume+filer+gateway | 落选（版本化结构性缺口）；留作 RustFS 冒烟不过的 fallback |
| Garage / pgsty-silo | AGPL-3.0 | — | — | — | 排除（协议问题原样） |
| Ceph RGW / Apache Ozone | LGPL-2.1 / Apache-2.0 | ✅ | ✅ | 重 | 排除（单节点 2TB 档运维不匹配） |

RustFS 已知边缘（excluded_tests 登记，不涉本部署）：ListParts 在参与节点不可用时 503（单节点 N/A）；DeleteObjects 需 Content-MD5/checksum 头（aws-sdk-go-v2 自动携带，集成测试断言）。

## 3. 部署差异映射（minio → rustfs）

| 项 | MinIO（现状） | RustFS（切换后） |
|---|---|---|
| 镜像 | `minio/minio:RELEASE.2024-11-07T00-52-20Z` | `rustfs/rustfs:1.0.5`（alpine 底、自带 curl、非 root uid 10001、`VOLUME /data`；生产经公司 Harbor 中转） |
| 端口 | 9000 S3 + 9001 console（`--console-address`） | 9000 S3 + 9001 console（内置，无需 flag）；9001 仍仅 `127.0.0.1` 发布 |
| 凭据 env | `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` | `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`（与服务端 `BBW_S3_ACCESS_KEY/SECRET_KEY` 同值） |
| healthcheck | `/minio/health/live` | **`/health/ready`**（就绪语义：存储+IAM 全绿才 200；`/minio/health/live` 兼容别名仍在但用 ready） |
| command | `server /data --console-address :9001` | 无需 command（默认 `rustfs` 即单节点 `/data`） |
| 卷 | `minio-data:/data` | `rustfs-data:/data`（命名卷首次挂载继承镜像属主 10001，**无需** chown/perm-init 容器；host bind 才需） |

Go 侧装配不变：`BBW_S3_ENDPOINT` 默认值 `http://minio:9000`→`http://rustfs:9000`；nginx 两处 `/oss/` `proxy_pass` upstream 同步改名（strip 前缀+Host 透传语义与后端实现无关，不动）。

## 4. rustfs-init 脚本等价映射（mc → aws s3api）

| mc（现状） | aws s3api（等价） |
|---|---|
| `mc alias set local http://minio:9000 …` | `AWS_ENDPOINT_URL` env（aws-cli 2 原生支持） |
| `mc mb -p local/bbw-data` | `aws s3api create-bucket --bucket bbw-data` |
| `mc version enable local/bbw-data` | `aws s3api put-bucket-versioning --versioning-configuration Status=Enabled` |
| `mc cors add … --allowed-origins "*" …` | `aws s3api put-bucket-cors --cors-configuration '{"CORSRules":[{AllowedOrigins:["*"],AllowedMethods:["GET","PUT","POST","HEAD"],AllowedHeaders:["content-type","x-amz-*"],ExposeHeaders:["ETag"],MaxAgeSeconds:3600}]}'` |

桶口径不变（D25 §2）：`bbw-data`（版本化+CORS）+ `bbw-backup`；幂等 `|| true` 保留；init 镜像 `amazon/aws-cli:2.31.4`，凭据经 `AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_DEFAULT_REGION=us-east-1` 注入。

## 5. 存量数据迁移（口径：v0.1 未发壳，无生产存量）

登记备用：若未来已有 MinIO 存量，双容器 `aws s3 sync`（旧 minio 临时容器→rustfs）一次性搬，`t/{tenant}/…` 键布局不变、file 表零改（同 D25 mc mirror 口径）。`migrate-files-to-s3.sh`（本地盘→桶）同步改用 aws cli，复用 rustfs-init 作载体。

## 6. 冒烟与验收

**编码批内（本地，RustFS 1.0.5 临时容器 :9100）**：健康端点（ready/minio 兼容）→ aws-cli 建桶/版本化/CORS 写读断言 → `BBW_TEST_S3_ADDR` 门控集成测试（store 层全操作：PutObject/GetObject/HeadObject/CopyObject/multipart 全家/ListObjectsV2/DeleteObjects + **presign 真链**：分片 PUT 预签名实传（UNSIGNED-PAYLOAD 验签）+ GET 票据实取）。

**真机验收（归用户，并入 D25 §9 六项一起走）**：compose 栈 `docker compose --profile core up` 后 webview >8MB 直传/120s 票据/缩略变体/nginx `/oss/` 前缀签名链全通。

## 7. 遗留登记

- `.env.tpl` 的 `BBW_S3_USE_PATH_STYLE`/`BBW_S3_BACKUP_BUCKET` 为幽灵键（Go 代码不读，path-style 硬编码 true）——本批不动，另行清理
- 历史设计篇（02/07/13/15/16 等）的 MinIO 措辞保留为设计时点记录，以本篇注记为准；01 篇 A.1/A.2 已随本批改判
- RustFS 单一公司主导的治理风险：以「S3 协议出口+sha256 内容寻址」保证可再迁移（SeaweedFS/云 S3），Harbor 内留镜像副本
