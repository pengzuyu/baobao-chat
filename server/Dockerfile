# 多阶段构建：golang builder → alpine 运行层（唯一第三方依赖 pgx v5，无 CGO）
# 构建：docker build -t bbw-server ./server（或 make server-image，tag 自动对齐 .env）
# 运行：docker run -p 8080:8080 -e BBW_JWT_SECRET=<32+字节随机串> bbw-server
# 子命令：bbw-server migrate / admin bootstrap（16 篇 §2.2/§4.4 部署通道引用）；
# /healthprobe 为 compose 健康检查专用静态探针（§3.4 镜像清单）。
#
# 内网镜像源：基础镜像经 build-arg 覆盖（BBW_GO_BUILDER / BBW_RUNTIME_IMAGE，
# make server-image 自动透传），或本地 docker tag 别名成默认名。
# 运行层默认 alpine（gcr.io distroless 内网不可达）；外网/生产环境可
# BBW_RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot 切回——二进制
# 静态无 CGO，两运行层通用（切 distroless 时 USER bbw 行需一并调整）。

ARG GO_BUILDER_IMAGE=golang:1.22-alpine
ARG RUNTIME_IMAGE=alpine:3.20
ARG GOPROXY=https://goproxy.cn,direct

FROM ${GO_BUILDER_IMAGE} AS build
WORKDIR /src
# 容器内模块代理（宿主机可达 proxy.golang.org 但 buildkit 容器网络未必；
# 外网环境可 build-arg 传回官方源）。全局 ARG 须经阶段内 ARG 引入再 ENV 固化
ARG GOPROXY
ENV GOPROXY=${GOPROXY}

# 依赖层（go.sum 一并拷入，下载校验）
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/bbw-server ./cmd/bbw-server \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/healthprobe ./cmd/healthprobe

# ── 运行镜像：alpine minimal（非 root 运行）──
# 静态二进制不依赖任何系统库；时区经 Go 内嵌 tzdata（main import time/tzdata），
# 出站 TLS 根证书随真实外呼需求再补（阶段一内网链路全 http/sslmode=disable）。
FROM ${RUNTIME_IMAGE}
RUN addgroup -S bbw && adduser -S bbw -G bbw
COPY --from=build /out/bbw-server /bbw-server
COPY --from=build /out/healthprobe /healthprobe
EXPOSE 8080
USER bbw
ENTRYPOINT ["/bbw-server"]
