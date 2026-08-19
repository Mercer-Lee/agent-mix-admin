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
docker compose up -d              # local Postgres + Redis
pnpm dev                          # admin :3100 · server :3101 · agent-worker
```

See [.env.example](.env.example) for the environment variable template. Control-plane health check: `curl localhost:3101/api/health`.

## Status

🚧 Skeleton in place: pnpm workspace + Turborepo, with `apps/admin` (Next.js 16 + antd 6 + Tailwind v4 utilities), `apps/server` (NestJS 11, control plane), `apps/agent-worker` (BullMQ execution plane), `packages/core` (Agent Spec / Zod), `packages/sdk`, `packages/ui`. Everything builds, typechecks pass, and server/worker smoke-start cleanly.

Roadmap:

- [ ] Phase 1 "RuoYi with AI": RBAC + org structure + audit + model config + built-in chat Agent
- [ ] Phase 2 "Agents as resources": declarative agent definitions + MCP tool registry + versioned releases + HITL approvals
- [ ] Phase 3 "Enterprise depth": cost allocation + evals + knowledge-base plugin + OIDC

## License

Planned: Apache-2.0 for the core, commercial licensing for selected enterprise modules (open-core).
