# =============================================================================
# BaobaoChat 接入层镜像（K8s 形态的 nginx-lb 等价物；2026-11-23）
#
# 职责（与 compose 的 nginx-lb + website + update-src 三服务等价合一）：
#   一个 NodePort 入口统一分流：/api /ws /v1 /mcp → bbc-app；
#   /oss → bbc-rustfs；/update/ → 本地更新源目录（PVC）；/ → 内置官网静态。
# 为什么需要它：客户端编译期固定 BBC_PUBLIC_URL，updater 打
# <BBC_PUBLIC_URL>/update/latest.json、API 打 /api——三者必须同域同口。
# K8s 形态下 app 直接用 NodePort 会让 /update 无处安放，故用本镜像做唯一入口。
#
# 构建（CI 内联；本地等价）：
#   mkdir -p build/website-dist && cp -R website/dist/. build/website-dist/
#   cp deploy/k8s/baobao-chat/web-image/{Dockerfile,nginx.conf} build/
#   docker build --platform linux/amd64 -t <registry>/baobaochat/web:<ver> build/
# 运行期更新源：/usr/share/nginx/updates 挂 PVC，发布脚本 rsync/kubectl cp 灌入
# （latest.json + release-info.json + releases/v<ver>/<platform>/…）
# =============================================================================
FROM nginx:1.27.4-alpine3.21

COPY nginx.conf /etc/nginx/nginx.conf
COPY --chown=nginx:nginx website-dist/ /usr/share/nginx/html/

# 更新源目录（运行期由 PVC 覆盖；镜像内保留空目录防未挂载时 403）
RUN mkdir -p /usr/share/nginx/updates && chown nginx:nginx /usr/share/nginx/updates

EXPOSE 80