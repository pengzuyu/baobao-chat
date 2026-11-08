# 多阶段构建：golang:1.22-alpine → distroless（零第三方依赖，无 CGO）
# 构建：docker build -t bbw-server ./server
# 运行：docker run -p 8080:8080 -e BBW_JWT_SECRET=<32+字节随机串> bbw-server
# 运行基镜像可被 build-arg 覆盖：gcr.io 不可达的网络环境用镜像源，如
#   --build-arg RUNTIME_IMAGE=gcr.nju.edu.cn/distroless/static-debian12:nonroot
#   （或 scratch：静态二进制无外部依赖，同样成立）
# 注意：供 FROM 使用的 ARG 必须声明在首个 FROM 之前（全局作用域），
#       放在 stage 之间则只属于该 stage，后续 FROM 不可见。

ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot

FROM golang:1.22-alpine AS build
WORKDIR /src

# 依赖层（零第三方依赖，仅做缓存占位）
COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/bbw-server ./cmd/bbw-server

# ── 运行镜像：distroless static（无 shell，攻击面最小）──
FROM ${RUNTIME_IMAGE}
COPY --from=build /out/bbw-server /bbw-server
EXPOSE 8080
# 数值 UID/GID：distroless nonroot 即 65534，且对 scratch 同样可移植
USER 65534:65534
ENTRYPOINT ["/bbw-server"]
