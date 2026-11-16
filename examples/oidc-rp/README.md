# 最小 OIDC RP 示例（D28 批4/Q4）

演示 bbw 统一登录（OIDC Provider）的**标准第三方客户端**接入全链：
discovery 自动发现 → 授权码 + PKCE(S256) → **ID Token 经 jwks 公钥本地验签**（签名/iss/aud/exp/nonce 全校验，库内完成）→ userinfo 拉取。

任何语言的标准 OIDC 库（Spring Security / passport / next-auth / Grafana Generic OAuth）接线方式同理：**填 issuer + client_id + 回调地址即可**。

## 使用

1. 起服务端（`:8090`），在 bbw 客户端「管理 · 登录接入」新建客户端，回调地址填 `http://localhost:7070/cb`，记下 `client_id`；
2. 启动本示例：

   ```sh
   BBW_CLIENT_ID=bbw-xxxxxxxxxxxx go run .
   # 可选 env：BBW_ISSUER（默认 http://127.0.0.1:8090/oauth2）/ PORT（默认 7070）
   ```

3. 浏览器打开 <http://localhost:7070> → 「使用 BaobaoChat 登录」；
   - 桌面端在开：页面深链唤起确认卡 → 核对 6 位码 → 点头像完成；
   - 桌面端不在：页面直接工号密码登录；
   - 该浏览器 7 天内登录过：**免密直达**（IdP 浏览器会话，D28 §5.3）；
4. 成功页展示 ID Token Claims（已验签）与 Userinfo——`aud` 即本应用 client_id、`amr` 标认领通道（`pwd`/`desktop-confirm`）。

## 无浏览器验收（curl）

```sh
J=/tmp/jar; rm -f $J
L=$(curl -s -o /dev/null -w '%{redirect_url}' -c $J http://localhost:7070/login)        # → bbw authorize
L=$(curl -s -o /dev/null -w '%{redirect_url}' -b $J -c $J "$L")                          # → wait 页（拿 id）
RID=$(echo "$L" | sed 's/.*id=//')
W=$(curl -s -o /dev/null -w '%{redirect_url}' -b $J -c $J -X POST \
     http://127.0.0.1:8090/oauth2/web-login -d "id=$RID&account=工号&password=密码")       # 账密兜底通道
CB=$(curl -s -o /dev/null -w '%{redirect_url}' -b $J -c $J "$W")                          # → RP 回调?code=
curl -s -b $J "$CB" | grep 登录成功                                                       # 验签通过
```
