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
cp .env.example .env             # set BOOTSTRAP_ADMIN_PASSWORD (12+ characters)
pnpm db:migrate && pnpm db:seed   # schema + bootstrap administrator
pnpm dev                          # admin :3100 · server :3101 · agent-worker
```

For local development, prefer reusing PostgreSQL and Redis already installed on the host, and configure `DATABASE_URL` and `REDIS_URL` in `.env` accordingly. If either service is unavailable locally, start the containerized dependencies with the repository's Compose configuration:

```bash
docker compose up -d              # containerized Postgres + Redis
```

Docker Desktop includes the `docker compose` subcommand, so the legacy standalone `docker-compose` installation is not required. See [.env.example](.env.example) for the environment variable template. Control-plane health check: `curl localhost:3101/api/health`.

## Status

🚧 Phase 1 is in progress. The first two control-plane milestones are complete:

- [x] **Phase 1A — Control-plane foundation:** Drizzle/PostgreSQL schema, database-backed sessions, unified user/role/agent RBAC, audit events, protected Admin authentication, and isolated integration tests.
- [x] **Phase 1B — Governed Agent resources:** Capability Registry and executor, the `users.search` vertical slice, Agent CRUD and status management, role/direct-permission assignment, live capability discovery, and the Admin Agent management UI.
- [ ] **Next — AI runtime entry point:** model configuration and the built-in chat Agent, while preserving the control-plane/execution-plane boundary.

MCP transport, asynchronous worker execution, approval flows, and versioned Agent releases remain later milestones.

Roadmap:

- [ ] Phase 1 "RuoYi with AI": control-plane foundation and governed Agent management are complete; model config + built-in chat Agent remain
- [ ] Phase 2 "Agents as resources": declarative agent definitions + MCP tool registry + versioned releases + HITL approvals
- [ ] Phase 3 "Enterprise depth": cost allocation + evals + knowledge-base plugin + OIDC

## License

Planned: Apache-2.0 for the core, commercial licensing for selected enterprise modules (open-core).
