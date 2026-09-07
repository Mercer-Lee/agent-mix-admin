# AgentMix Admin

English | [简体中文](README.zh-CN.md)

> An enterprise-grade admin framework that treats AI Agents as first-class, governed resources — the foundation for bringing Agents into your internal systems.

**AgentMix** manages AI Agents as unified enterprise resources: who created them, who published them, which departments can use them, which tools they call, and what they cost — all manageable, auditable, and reversible.

## Why not another Dify?

Dify and its peers are "app-centric" — built for shipping individual AI applications. AgentMix is "organization-centric" — a foundation for internal enterprise systems. The core strengths of a traditional admin — accounts, roles, org structure, audit trails, approval flows — are fused with Agent lifecycle management, a model gateway, and cost accounting in a single framework.

Core pillars:

1. **Agents as first-class citizens** — Agents join users and roles in a single RBAC model
2. **Control plane / execution plane separation** — Admin governs, Runtime executes, connected by queues, scaling independently
3. **Model gateway + cost center** — multi-model access, secrets vault, per-department cost allocation
4. **Human-in-the-loop** — sensitive tool calls suspend into an approval center; a framework-level capability
5. **MCP-first, pluggable** — the tool system reuses the MCP ecosystem; no private tool protocols, no homegrown orchestration engine

## Quick Start

```bash
corepack enable && pnpm install   # Node ≥22.13, pnpm ≥10
cp .env.example .env             # set PostgreSQL variables + DATABASE_URL,
                                  # BOOTSTRAP_ADMIN_PASSWORD, and model variables
pnpm db:migrate && pnpm db:seed   # schema + bootstrap administrator
pnpm dev                          # admin :3100 · server :3101 · agent-worker
```

For local development, prefer reusing PostgreSQL and Redis already installed on the host, and configure `DATABASE_URL` and `REDIS_URL` in `.env` accordingly. When using Compose, fill `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`, then make `DATABASE_URL` use those same values. If either service is unavailable locally, start the containerized dependencies with the repository's Compose configuration:

```bash
docker compose up -d              # containerized Postgres + Redis
```

Docker Desktop includes the `docker compose` subcommand, so the legacy standalone `docker-compose` installation is not required. See [.env.example](.env.example) for the environment variable template. Control-plane health check: `curl localhost:3101/api/health`.

## Status

✅ Phase 1 is complete:

- [x] **Phase 1A — Control-plane foundation:** Drizzle/PostgreSQL schema, database-backed sessions, unified user/role/agent RBAC, audit events, protected Admin authentication, and isolated integration tests.
- [x] **Phase 1B — Governed Agent resources:** Capability Registry and executor, the `users.search` vertical slice, Agent CRUD and status management, role/direct-permission assignment, live capability discovery, and the Admin Agent management UI.
- [x] **Phase 1C — Governed runtime loop:** environment-backed model profiles, explicit user/role/department invocation grants, a protected system Agent, transactional outbox, BullMQ streaming Runtime, reconnectable SSE chat, cancellation, the authorized `users.search` bridge, usage, model checks, and content-separated conversation audit.

The Worker never reads PostgreSQL or calls Server HTTP, and the Server never calls the model. Credentials stay in Worker environment variables. General MCP transport, approval flows, and versioned Agent releases remain Phase 2 work.

Roadmap:

- [x] Phase 1 "RuoYi with AI": governed model-to-Agent-to-Runtime-to-tool-to-audit vertical loop
- [ ] Phase 2 "Agents as resources": declarative agent definitions + MCP tool registry + versioned releases + HITL approvals
- [ ] Phase 3 "Enterprise depth": cost allocation + evals + knowledge-base plugin + OIDC

## License

Planned: Apache-2.0 for the core, commercial licensing for selected enterprise modules (open-core).

## Verification

`pnpm test:integration` starts isolated PostgreSQL 17 and Redis 7 Testcontainers and uses a local fake OpenAI-compatible SSE service. Override images with `TEST_POSTGRES_IMAGE` and `TEST_REDIS_IMAGE` when reusing a local registry or cached image.
