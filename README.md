# AgentMix Admin

**[中文](#中文) · [English](#english)**

---

## 中文

[⇄ English version](#english)

> 企业级 Admin + Agent 一体化后台框架 —— 给企业内部系统装上 Agent 的底座。

**AgentMix** 把 AI Agent 当作一种被统一管理的企业资源：谁创建、谁发布、哪个部门可用、调用了哪些工具、花了多少钱，全部可管、可审、可回滚。

### 为什么不是又一个 Dify？

Dify 们是「App 中心」——面向构建单个 AI 应用；AgentMix 是「组织中心」——面向企业内部系统底座。账号、角色、组织架构、审计、审批流这些传统 Admin 的看家能力，与 Agent 的生命周期管理、模型网关、成本核算融合在同一套框架里。

核心支柱：

1. **Agent 一等公民** —— Agent 纳入 RBAC，与用户、角色同处一个权限模型
2. **控制面/执行面分离** —— Admin 管治理，Runtime 跑任务，队列连接，独立扩缩
3. **模型网关 + 成本中心** —— 多模型接入、密钥保险箱、按部门分摊账单
4. **Human-in-the-loop** —— 敏感工具调用挂起进入审批中心，框架级能力
5. **MCP-first、插件化** —— 工具系统复用 MCP 生态，不造私有协议，不自研编排引擎

### 快速开始

```bash
corepack enable && pnpm install   # Node ≥22.13，pnpm ≥10
docker compose up -d              # 本地 Postgres + Redis
pnpm dev                          # admin :3100 · server :3101 · agent-worker
```

环境变量模板见 [.env.example](.env.example)。控制面 API 健康检查：`curl localhost:3101/api/health`。

### 状态

🚧 骨架已落地：pnpm workspace + Turborepo，`apps/admin`（Next.js 16 + antd 6 + Tailwind v4 工具类）、`apps/server`（NestJS 11，控制面）、`apps/agent-worker`（BullMQ 执行面）、`packages/core`（Agent Spec / Zod）、`packages/sdk`、`packages/ui`。全部可构建、类型检查通过、server/worker 冒烟启动正常。

这个项目为什么存在、边界在哪里，见 [docs/vision.md](docs/vision.md)（愿景与缘起）；架构设计见 [docs/architecture.md](docs/architecture.md)。

路线图：

- [ ] Phase 1「带 AI 的若依」：RBAC + 组织 + 审计 + 模型配置 + 内置对话 Agent
- [ ] Phase 2「Agent 资源化」：声明式 Agent 定义 + MCP 工具注册 + 版本发布 + HITL 审批
- [ ] Phase 3「企业深化」：成本分摊 + 评测 + 知识库插件 + OIDC

### License

规划：核心 Apache-2.0，部分企业模块商业授权（open-core）。

---

## English

[⇄ 中文版本](#中文)

> An enterprise-grade admin framework that treats AI Agents as first-class, governed resources — the foundation for bringing Agents into your internal systems.

**AgentMix** manages AI Agents as unified enterprise resources: who created them, who published them, which departments can use them, which tools they call, and what they cost — all manageable, auditable, and reversible.

### Why not another Dify?

Dify and its peers are "app-centric" — built for shipping individual AI applications. AgentMix is "organization-centric" — a foundation for internal enterprise systems. The core strengths of a traditional admin — accounts, roles, org structure, audit trails, approval flows — are fused with Agent lifecycle management, a model gateway, and cost accounting in a single framework.

Core pillars:

1. **Agents as first-class citizens** — Agents join users and roles in a single RBAC model
2. **Control plane / execution plane separation** — Admin governs, Runtime executes, connected by queues, scaling independently
3. **Model gateway + cost center** — multi-model access, secrets vault, per-department cost allocation
4. **Human-in-the-loop** — sensitive tool calls suspend into an approval center; a framework-level capability
5. **MCP-first, pluggable** — the tool system reuses the MCP ecosystem; no private tool protocols, no homegrown orchestration engine

### Quick Start

```bash
corepack enable && pnpm install   # Node ≥22.13, pnpm ≥10
docker compose up -d              # local Postgres + Redis
pnpm dev                          # admin :3100 · server :3101 · agent-worker
```

See [.env.example](.env.example) for the environment variable template. Control-plane health check: `curl localhost:3101/api/health`.

### Status

🚧 Skeleton in place: pnpm workspace + Turborepo, with `apps/admin` (Next.js 16 + antd 6 + Tailwind v4 utilities), `apps/server` (NestJS 11, control plane), `apps/agent-worker` (BullMQ execution plane), `packages/core` (Agent Spec / Zod), `packages/sdk`, `packages/ui`. Everything builds, typechecks pass, and server/worker smoke-start cleanly.

For why this project exists and where its boundaries are, see [docs/vision.md](docs/vision.md); for architecture design, see [docs/architecture.md](docs/architecture.md).

Roadmap:

- [ ] Phase 1 "RuoYi with AI": RBAC + org structure + audit + model config + built-in chat Agent
- [ ] Phase 2 "Agents as resources": declarative agent definitions + MCP tool registry + versioned releases + HITL approvals
- [ ] Phase 3 "Enterprise depth": cost allocation + evals + knowledge-base plugin + OIDC

### License

Planned: Apache-2.0 for the core, commercial licensing for selected enterprise modules (open-core).
