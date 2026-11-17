# frp 最小公网暴露实验台（阶段一）

供 **frp / 樱花frp** 把阶段一内存版 `bbc-server`（单容器，无需 PG/Redis/MinIO）
暴露到公网做双端对话测试。安全目标：**即使容器/隧道被攻破，也不波及宿主机**。

```
Windows/macOS 桌面端 ──https/wss──► frp 节点（公网）
                                        │ 隧道（launcher 主动出站，宿主机零入站）
                                  内网宿主机
                                    ├─ frp launcher（普通用户运行，只指向 127.0.0.1）
                                    ├─ 路径B: 127.0.0.1:8443 → nginx(TLS) → bbc:8080
                                    └─ 路径A: 127.0.0.1:8080 → bbc:8080
```

## 0. 先判定你的隧道形态（30 秒）

| 判据 | L7 HTTPS 隧道 | TCP 隧道 |
|---|---|---|
| 樱花frp 面板"类型"列 | HTTP(S) | TCP |
| 入口 URL | `https://域名`（无端口，证书有效） | `https://IP:端口` 或 `IP:端口` |
| `curl -v https://<入口>/healthz` | 证书握手成功 | TCP+明文后端时握手失败 |

L7 → 走 **路径 A**；TCP → 走 **路径 B**（本目录全量）。两条路径用同一个 compose。

## 路径 A：L7 HTTPS 隧道（TLS 由节点终止）

```bash
cp .env.tpl .env && vim .env          # 填 BBC_JWT_SECRET（openssl rand -hex 32）
docker compose up -d --build          # 只跑 bbc（nginx 属 tls profile，不启）
# 樱花frp 隧道本地地址填：127.0.0.1:8080
```

注意：L7 形态下 TLS 在节点侧终止，节点→家这段明文与否取决于樱花实现——
**测试对话不要含真实敏感内容**。WSS 能否透传需验证（见 §3），不通则转路径 B。

## 路径 B：TCP 隧道（端到端 TLS 自持，樱花只见密文）

```bash
cp .env.tpl .env && vim .env                          # 填 BBC_JWT_SECRET
./gen-cert.sh <节点IP或域名>                           # 生成 CA + 服务端证书（SAN=入口）
docker compose --profile tls up -d --build            # bbc + nginx TLS 终止
# 樱花frp 隧道本地地址填：127.0.0.1:8443
```

换节点 = 重新执行 `./gen-cert.sh <新节点IP>` + `docker compose restart nginx`
（CA 不变，测试机无需重装信任）。

### 两台测试机安装根 CA 信任（路径 B 必须，一次性）

```bash
# Windows（管理员 PowerShell/CMD）
certutil -addstore -f Root certs\ca.crt
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/ca.crt
```

WebView2 / WKWebView 均走系统信任库，装完即认。测完删除：
`certutil -delstore Root bbc-frp-lab-CA` / 钥匙串访问删除 `bbc-frp-lab-CA`。

## 3. 外网验证（两种路径通用）

```bash
# 健康检查：应返回 {"status":"ok","stage":"stage1"}
curl -v https://<入口>/healthz

# WSS 升级链路（IM 测试的硬前提）：返回 bbc 的 401/400 JSON 即证明透传成功；
# 若返回节点自身错误页 / 502 / 超时 → L7 拦了 WebSocket，转路径 B
curl -vi --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://<入口>/ws/connect?did=probe"
```

## 4. 客户端连接（两台测试机）

| 形态 | VITE_API_BASE | VITE_WS_BASE |
|---|---|---|
| L7 | `https://<域名>/api/v1` | `wss://<域名>/ws/connect` |
| TCP | `https://<IP:端口>/api/v1` | `wss://<IP:端口>/ws/connect` |

```bash
cd client && npm install
VITE_API_BASE=<上表> VITE_WS_BASE=<上表> npm run tauri dev
```

账号：`alice` / `bob`（tenant_id=1，口令 `demo-pass-123`，阶段一演示数据）。
验收清单：登录→WS 心跳→互发消息（`msg.send.ack` 的 seq 单调、对端 `msg.new`
实时）→已读游标→断线重连按 seq 补拉。音视频不可经 frp 测试（UDP 大端口段+ICE）。

## 5. 安全边界

- 端口仅 `127.0.0.1` 发布：frp 之外无人可达容器；宿主机零入站（launcher 只出站）。
- 容器加固：distroless + nonroot + `cap_drop ALL` + `no-new-privileges` +
  `read-only` + `pids/mem/cpus` 上限；不挂 docker.sock、无 host 网络。
- 宿主机侧建议（Linux）：`/etc/docker/daemon.json` 开 `"userns-remap": "default"`
  （容器 root ≠ 宿主 root，防逃逸核心）；Windows 宿主由 WSL2 VM 隔离天然覆盖。
- 樱花frp：launcher 用普通用户跑、隧道开 IP 白名单/限速（面板支持）、
  访问密钥即公网钥匙，勿泄漏。
- **测完即关**：面板停隧道 + `docker compose down`。演示口令 `demo-pass-123`
  硬编码在骨架里，不要长期暴露公网。

## 6. 与主栈的关系

本实验台只服务阶段一（内存仓储，重启数据清零）。repo 层接通 PG 后切
`deploy/compose/` 全量栈（nginx-lb + app×2 + pg/redis/minio），届时
frp 隧道本地地址改指 `127.0.0.1:443`，本目录可归档。
