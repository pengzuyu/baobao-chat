# 多阶段构建：golang:1.22-alpine → distroless（零第三方依赖，无 CGO）
# 构建：docker build -t bbw-server ./server
# 运行：docker run -p 8080:8080 -e BBW_JWT_SECRET=<32+字节随机串> bbw-server

FROM golang:1.22-alpine AS build
WORKDIR /src

# 依赖层（零第三方依赖，仅做缓存占位）
COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/bbw-server ./cmd/bbw-server

# ── 运行镜像：distroless static（无 shell，攻击面最小） ──
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/bbw-server /bbw-server
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/bbw-server"]
