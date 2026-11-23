<div align="center">

# BaobaoChat

**Self-hosted enterprise IM + AI agent workspace**

Team chat · Directory · Knowledge base · A locally-executed AI agent · Plugins & MCP

`MIT License` · `Windows / macOS / Linux` · `Docker Compose / Kubernetes`

[中文 README](README.md)

</div>

---

BaobaoChat puts **team chat** and **an AI agent that actually works on the employee's machine**
into one desktop client. The server is fully self-hosted: data never leaves your network,
and every agent action is visible and approvable.

- **Enterprise IM** — 1:1 and group chats, broadcast channels, directory, presence, multi-device sync, file transfer
- **AI agent workspace** — the agent runs locally on the user's machine, with three permission tiers, inline approvals, sub-agents and scheduled tasks
- **Knowledge base** — company knowledge plus personal notes, Chinese-aware retrieval with permission filtering, answers traceable to the source
- **Plugins & MCP** — a superset of the Claude Code plugin format, three MCP sources, capabilities delivered on demand
- **Callable from outside** — an in-shell A2A / MCP server lets Claude Code, zcode and other agents call BaobaoChat in one command
- **Governance** — multi-tenant isolation, RBAC, OIDC SSO, AI gateway, hash-chained audit log, client release management

## Why not just an AI chat panel?

| Concern | BaobaoChat | AI chat panels (LibreChat / Open WebUI) | Enterprise IM (Tailchat / WildFire) | AI app platforms (Dify) |
|---|---|---|---|---|
| Employee-to-employee chat | ✅ | ❌ | ✅ | ❌ |
| Agent runs on the user's machine, with local permissions | ✅ local sidecar | ⚠️ server-side tools | ⚠️ plugin relay | ❌ server workflows |
| Visible reasoning + tiered approval | ✅ | ⚠️ partial | ❌ | ⚠️ partial |
| Knowledge base / RAG | ✅ with permission filtering | ⚠️ basic | ⚠️ via plugins | ✅ |
| Multi-tenant RLS / RBAC / audit chain | ✅ | ⚠️ basic | ⚠️ group-level | ⚠️ workspaces |
| Desktop client | ✅ Tauri (Win / macOS / Linux) | ⚠️ mostly web | ⚠️ web / shell | ⚠️ web |
| White-label | ✅ one brand directory | ⚠️ code changes | ⚠️ code changes | ⚠️ commercial edition |

> Compared by positioning, not by "who is better". Capabilities change with releases — check each project's docs.
> This product currently **does not** include audio/video calls, meetings, collaborative documents, or a mobile app.

## Core design

1. **Local execution** — the server authenticates, routes, proxies model calls and audits; it never executes user code.
2. **On-behalf-of (OBO)** — the agent acts with the user's short-lived token plus an `act` claim, double-written to audit. No service-level superuser.
3. **Least privilege** — ask / auto-edit / full-auto tiers; risky actions always require approval. No silent blocking.
4. **Everything auditable** — messages, document access, tool calls and admin actions are append-only and hash-chained.
5. **Hard multi-tenancy** — `tenant_id` across every table and API, row-level security, per-tenant storage prefixes.
6. **Permission-first retrieval** — knowledge-base queries inject the caller's visible set into SQL instead of post-filtering.

## Tech stack

```
Client   Tauri 2 + React 18 + TypeScript + Ant Design 5 + Zustand
Agent    Rust sidecar (in-house loop, stdio JSONL, OpenAI-compatible streaming)
Server   Go modular monolith (gateway / auth / org / message / file / kb /
         app-registry / ai-gateway / admin / audit / notify)
Data     PostgreSQL 16 (pgvector + zhparser + partitioning) · Redis 7
         · S3-compatible object storage (RustFS)
AI       ai-gateway: GLM / Qwen / DeepSeek / vLLM / Ollama
Ship     docker compose / Helm chart / offline bundle; signed, staged client updates
```

## Quick start (single-node Compose)

Requirements: Linux, Docker 24+ with Compose v2.20+, 4 vCPU / 8 GB RAM to start.

```bash
tar xzf baobaochat-deploy-v<ver>.tar.gz
cd baobaochat-deploy-v<ver>
sha256sum -c SHA256SUMS | tail -3

docker load -i images/bbc-app-<ver>.tar.gz
docker load -i images/base-images.tar.gz

cp compose/.env.internal compose/.env
# Three values must be set:
#   BBC_PUBLIC_DOMAIN      = <server IP or domain>  (no scheme)
#   BBC_S3_PUBLIC_ENDPOINT = http://<server address>/oss
#   POSTGRES_PASSWORD and BBC_DB_DSN must match

cd compose
docker compose --profile core up -d
docker compose ps
```

Then open `http://<server address>/` — it redirects to `/setup` to create the first super admin
(an empty database ships with no demo accounts). Configure an AI provider in the admin console
to enable the agent.

> **Address contract**: the desktop client hard-codes the server address at build time
> (`BBC_PUBLIC_URL`). The client you distribute must be built for the address you deploy.

See [deploy/compose/README.md](deploy/compose/README.md) for the full walkthrough.

## Deployment options

| Form | Best for |
|---|---|
| Docker Compose | Single VM, small internal deployments (≤ 2k users) |
| Kubernetes (Helm) | Existing clusters, multiple replicas, self-healing |
| Offline bundle | Air-gapped networks: all images plus an installer script |

## Out of scope

- Audio/video calls, meetings, collaborative documents (removed from the codebase)
- Native mobile app
- Public share links for files
- Delegating work to external CLI coding agents — BaobaoChat is *called by* them via A2A / MCP, not the other way around

## Documentation

Design documents (Chinese) live in [`docs/`](docs/); the index and reading paths are in the
[中文 README](README.md#设计文档).

## White-label

Product name, tagline, logo and mail domain are defined in [`brand/`](brand/README.md).
Edit one directory, run one generation command, and rebuild — MIT allows commercial and
internal white-label distribution.

## License

[MIT](LICENSE). Keep the LICENSE file when redistributing.