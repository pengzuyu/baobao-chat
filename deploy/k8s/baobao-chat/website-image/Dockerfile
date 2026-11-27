# =============================================================================
# BaobaoChat 官网独立站镜像（K8s 独立端口形态，2026-11-27）
#
# 与 web-image（接入层+内置官网）的区别：本镜像只含官网静态+同源反代配置，
# 部署在独立 NodePort——不动 30808 主入口（phebs/既有客户端零影响）。
# 联动语义不变：下载区运行时 fetch /update/release-info.json（反代主入口动态清单），
# 管理后台发布后官网下载区自动跟进，无需重建镜像。
#
# 构建（仓库根）：
#   npm --prefix website run build
#   mkdir -p build/website-dist && cp -R website/dist/. build/website-dist/
#   cp deploy/k8s/baobao-chat/website-image/{Dockerfile,default.conf.template} build/
#   docker buildx build --platform linux/amd64 --push \
#     -t <registry>/pengzuyu/bbc-website:<ver> build/
# =============================================================================
FROM nginx:1.27.4-alpine3.21

RUN rm -f /etc/nginx/conf.d/default.conf
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=nginx:nginx website-dist/ /usr/share/nginx/html/

EXPOSE 80
