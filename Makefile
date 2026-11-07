# =============================================================================
# BaobaoWork 根级 Makefile（三栈：server / client / agent + 双形态部署）
# 依赖文档：docs/detail/D02（服务端工程结构）· docs/16 §3.4（双形态部署）
# 惯例：make help 查看全部目标；设计阶段（代码栈未落地）目标会友好跳过
# =============================================================================

SHELL          := /bin/bash
COMPOSE_DIR    := deploy/compose
# .env 不存在时退回 .env.tpl（只读校验场景）
COMPOSE_ENV    := $(if $(wildcard $(COMPOSE_DIR)/.env),.env,.env.tpl)
COMPOSE        := cd $(COMPOSE_DIR) && docker compose --env-file $(COMPOSE_ENV)
HELM_DIR       := deploy/helm/bbw

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# 开发
# ---------------------------------------------------------------------------
.PHONY: help
help: ## 显示本帮助（中文目标说明）
	@echo "BaobaoWork Make 目标："
	@echo
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST) \
	  | sort -f

.PHONY: dev
dev: dev-up ## 一键开发：拉起 compose 依赖(core) + 启动前端 dev server
	@if [ -d client ]; then npm --prefix client run dev; \
	  else echo "[make] client/ 尚未创建（设计阶段），仅依赖已就绪，见 scripts/dev-up.sh 输出"; fi

.PHONY: dev-up
dev-up: ## 拉起本地依赖（compose core：pg/redis/minio；含自签证书与 .env 初始化）
	./scripts/dev-up.sh

.PHONY: dev-down
dev-down: ## 停止本地依赖（保留数据卷）
	$(COMPOSE) stop

.PHONY: dev-clean
dev-clean: ## 停止并删除本地依赖容器与数据卷（⚠ 清空本地数据）
	$(COMPOSE) down -v

# ---------------------------------------------------------------------------
# server（Go 模块化单体，D02）
# ---------------------------------------------------------------------------
.PHONY: server-build
server-build: ## 编译服务端（go build ./...）
	@if [ -d server ]; then cd server && go build ./...; else echo "[make] server/ 尚未创建（设计阶段），跳过"; fi

.PHONY: server-run
server-run: dev-up ## 本地运行 bbw-server（依赖 compose core，DSN 指向 127.0.0.1）
	@if [ -d server ]; then \
	  cd server && BBW_DB_DSN='postgres://bbw:bbw_change_me@127.0.0.1:5432/bbw?sslmode=disable' \
	    BBW_REDIS_ADDR=127.0.0.1:6379 BBW_S3_ENDPOINT=http://127.0.0.1:9000 \
	    BBW_S3_ACCESS_KEY=bbw_minio_change_me BBW_S3_SECRET_KEY=bbw_minio_secret_change_me \
	    go run ./cmd/bbw-server --enable auth,org,message,file,doc,kb,eco,admin,audit,notify,aigw; \
	  else echo "[make] server/ 尚未创建（设计阶段），跳过"; fi

.PHONY: server-image
server-image: ## 构建 bbw-app 容器镜像（版本取 .env 的 BBW_IMAGE_TAG）
	@if [ -f server/Dockerfile ]; then \
	  source deploy/compose/.env 2>/dev/null || source deploy/compose/.env.tpl; \
	  docker build -t $${BBW_IMAGE_REGISTRY}/bbw-app:$${BBW_IMAGE_TAG} server/; \
	  else echo "[make] server/Dockerfile 尚未创建（随 server/ 落地），跳过"; fi

# ---------------------------------------------------------------------------
# client（Tauri 2 + React，npm 三件套）
# ---------------------------------------------------------------------------
.PHONY: client-install
client-install: ## 前端依赖安装（npm install）
	@if [ -d client ]; then npm --prefix client install; else echo "[make] client/ 尚未创建（设计阶段），跳过"; fi

.PHONY: client-dev
client-dev: ## 前端开发服务器（npm run dev）
	@if [ -d client ]; then npm --prefix client run dev; else echo "[make] client/ 尚未创建（设计阶段），跳过"; fi

.PHONY: client-build
client-build: ## 前端生产构建（npm run build）
	@if [ -d client ]; then npm --prefix client run build; else echo "[make] client/ 尚未创建（设计阶段），跳过"; fi

.PHONY: client-typecheck
client-typecheck: ## 前端类型检查（npm run typecheck，若定义）
	@if [ -d client ] && grep -q '"typecheck"' client/package.json; then npm --prefix client run typecheck; \
	  elif [ -d client ]; then echo "[make] client 未定义 typecheck 脚本，跳过"; \
	  else echo "[make] client/ 尚未创建（设计阶段），跳过"; fi

# ---------------------------------------------------------------------------
# agent（Rust Agent Runtime sidecar，D11）
# ---------------------------------------------------------------------------
.PHONY: agent-build
agent-build: ## 编译 Agent Runtime（cargo build）
	@if [ -d agent ]; then cd agent && cargo build; else echo "[make] agent/ 尚未创建（设计阶段），跳过"; fi

# ---------------------------------------------------------------------------
# 测试与静态检查（聚合三栈）
# ---------------------------------------------------------------------------
.PHONY: test
test: test-server test-client test-agent ## 聚合三栈测试（不存在的栈自动跳过）

.PHONY: test-server
test-server: ## 服务端测试（go test ./...；含 RLS/契约测试，D02 §9）
	@if [ -d server ]; then cd server && go test ./...; else echo "[make] server/ 尚未创建，跳过"; fi

.PHONY: test-client
test-client: ## 前端测试（npm test）
	@if [ -d client ] && grep -q '"test"' client/package.json; then npm --prefix client test; \
	  elif [ -d client ]; then echo "[make] client 未定义 test 脚本，跳过"; \
	  else echo "[make] client/ 尚未创建，跳过"; fi

.PHONY: test-agent
test-agent: ## Agent Runtime 测试（cargo test）
	@if [ -d agent ]; then cd agent && cargo test; else echo "[make] agent/ 尚未创建，跳过"; fi

.PHONY: lint
lint: lint-server lint-client lint-agent check-deploy ## 聚合三栈 lint + 交付物校验

.PHONY: lint-server
lint-server: ## 服务端静态检查（go vet + golangci-lint 若安装）
	@if [ -d server ]; then cd server && go vet ./... && (command -v golangci-lint >/dev/null && golangci-lint run || echo "[make] 未安装 golangci-lint，仅 go vet"); \
	  else echo "[make] server/ 尚未创建，跳过"; fi

.PHONY: lint-client
lint-client: ## 前端静态检查（npm run lint 若定义）
	@if [ -d client ] && grep -q '"lint"' client/package.json; then npm --prefix client run lint; \
	  elif [ -d client ]; then echo "[make] client 未定义 lint 脚本，跳过"; \
	  else echo "[make] client/ 尚未创建，跳过"; fi

.PHONY: lint-agent
lint-agent: ## Agent Runtime 静态检查（cargo clippy）
	@if [ -d agent ]; then cd agent && cargo clippy -- -D warnings; else echo "[make] agent/ 尚未创建，跳过"; fi

# ---------------------------------------------------------------------------
# 部署交付物（compose / helm 双一等公民，16 篇 §3.4）
# ---------------------------------------------------------------------------
.PHONY: check-deploy
check-deploy: ## 校验部署交付物：compose config + helm 静态检查（无 helm 时）
	@$(COMPOSE) config --quiet && echo "✔ docker compose config 通过（$(COMPOSE_DIR)/$(COMPOSE_ENV)）"
	@if command -v helm >/dev/null; then \
	  helm lint $(HELM_DIR) && helm template bbw $(HELM_DIR) >/dev/null && echo "✔ helm template 渲染通过"; \
	else \
	  python3 scripts/check-helm-static.py; \
	fi

.PHONY: compose-up
compose-up: ## 启动 compose 全量（按 .env 的 COMPOSE_PROFILES）
	$(COMPOSE) up -d && $(COMPOSE) ps

.PHONY: compose-down
compose-down: ## 停止 compose（保留数据卷）
	$(COMPOSE) down

.PHONY: compose-ps
compose-ps: ## 查看 compose 服务与健康状态
	$(COMPOSE) ps

.PHONY: compose-logs
compose-logs: ## 跟随查看 app 日志
	$(COMPOSE) logs -f app

.PHONY: helm-template
helm-template: ## 渲染 Helm 模板到 stdout（需要 helm）
	@if command -v helm >/dev/null; then helm template bbw $(HELM_DIR); \
	  else echo "[make] 未安装 helm，改用静态检查：make check-deploy"; fi

.PHONY: helm-install
helm-install: ## 安装到 K8s（默认 values；中/大规模加 -f values-mid/large.yaml）
	@if command -v helm >/dev/null; then \
	  helm upgrade --install bbw $(HELM_DIR) --create-namespace -n bbw \
	  $$( [ -f $(HELM_DIR)/.local-values.yaml ] && echo -f $(HELM_DIR)/.local-values.yaml ); \
	  else echo "[make] 未安装 helm"; fi

.PHONY: clean
clean: ## 清理构建产物（不动数据卷）
	@if [ -d client ]; then rm -rf client/node_modules client/dist; fi
	@if [ -d agent ]; then cd agent && cargo clean 2>/dev/null || true; fi
	@if [ -d server ]; then cd server && go clean 2>/dev/null || true; fi
	@echo "✔ 清理完成（compose 数据卷未动：make dev-clean 可清数据）"

# ---------------------------------------------------------------------------
# 一键验证门（CI 同源；本地/流水线同一入口）
# ---------------------------------------------------------------------------
.PHONY: verify
verify: verify-server verify-client verify-agent verify-deploy ## 四栈硬门禁：编译+测试+静态检查+格式（CI 同源）

.PHONY: verify-server
verify-server: ## 服务端硬门禁：build + vet + gofmt -l 须空 + go test ./...
	@cd server && go build ./... && go vet ./... \
	  && [ -z "$$(gofmt -l .)" ] || { echo "❌ gofmt 未格式化文件："; gofmt -l .; exit 1; } \
	  && go test ./...

.PHONY: verify-server-pg
verify-server-pg: ## 服务端 PG 集成门禁（需 BBW_PG_TEST_DSN 或本机 bbw 容器）
	@cd server && if [ -z "$$BBW_PG_TEST_DSN" ]; then \
	  BBW_PG_TEST_DSN='postgres://bbw:bbw_change_me@127.0.0.1:5432/bbw?sslmode=disable' \
	  go test -tags pg ./internal/...; else go test -tags pg ./internal/...; fi

.PHONY: verify-client
verify-client: ## 前端硬门禁：tsc --noEmit + vite build
	@cd client && npm run build --silent >/dev/null && npx tsc -b --noEmit

.PHONY: verify-agent
verify-agent: ## Agent 硬门禁：test --workspace + clippy -D warnings + fmt --check
	@cd agent && if command -v cargo >/dev/null; then \
	  cargo test --workspace && cargo clippy --workspace --all-targets -- --deny warnings \
	  && cargo fmt --all --check; else echo "[make] cargo 不在 PATH（export PATH=\$$HOME/.cargo/bin:\$$PATH）"; exit 1; fi

.PHONY: verify-deploy
verify-deploy: ## 部署交付物校验：compose config（helm 若可用则 template）
	@$(COMPOSE) config --quiet && echo "compose ✓" \
	  && if command -v helm >/dev/null; then \
	    helm template $(HELM_DIR) >/dev/null && echo "helm ✓"; else echo "helm 未安装，跳过（compose 已过）"; fi

.PHONY: verify-quick
verify-quick: ## 快速门禁（跳过测试）：四栈 build/typecheck/clippy
	@cd server && go build ./... && go vet ./... && echo "server ✓"
	@cd client && npx tsc -b --noEmit && echo "client ✓"
	@cd agent && if command -v cargo >/dev/null; then cargo check --workspace && cargo clippy --workspace -- -D warnings && echo "agent ✓"; fi

.PHONY: e2e
e2e: ## 协议级 E2E 回归套件（进程内全栈：登录→WS→IM 全流，14 篇信封契约）
	@cd server && go test ./internal/e2e/ -v -count=1
