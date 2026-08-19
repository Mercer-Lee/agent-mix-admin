# AgentMix Admin

[English](README.md) | 简体中文

> 企业级 Admin + Agent 一体化后台框架 —— 给企业内部系统装上 Agent 的底座。

**AgentMix** 把 AI Agent 当作一种被统一管理的企业资源：谁创建、谁发布、哪个部门可用、调用了哪些工具、花了多少钱，全部可管、可审、可回滚。

## 为什么不是又一个 Dify？

Dify 们是「App 中心」——面向构建单个 AI 应用；AgentMix 是「组织中心」——面向企业内部系统底座。账号、角色、组织架构、审计、审批流这些传统 Admin 的看家能力，与 Agent 的生命周期管理、模型网关、成本核算融合在同一套框架里。

核心支柱：

1. **Agent 一等公民** —— Agent 纳入 RBAC，与用户、角色同处一个权限模型
2. **控制面/执行面分离** —— Admin 管治理，Runtime 跑任务，队列连接，独立扩缩
3. **模型网关 + 成本中心** —— 多模型接入、密钥保险箱、按部门分摊账单
4. **Human-in-the-loop** —— 敏感工具调用挂起进入审批中心，框架级能力
5. **MCP-first、插件化** —— 工具系统复用 MCP 生态，不造私有协议，不自研编排引擎

## 快速开始

```bash
corepack enable && pnpm install   # Node ≥22.13，pnpm ≥10
docker compose up -d              # 本地 Postgres + Redis
pnpm dev                          # admin :3100 · server :3101 · agent-worker
```

环境变量模板见 [.env.example](.env.example)。控制面 API 健康检查：`curl localhost:3101/api/health`。

## 状态

🚧 骨架已落地：pnpm workspace + Turborepo，`apps/admin`（Next.js 16 + antd 6 + Tailwind v4 工具类）、`apps/server`（NestJS 11，控制面）、`apps/agent-worker`（BullMQ 执行面）、`packages/core`（Agent Spec / Zod）、`packages/sdk`、`packages/ui`。全部可构建、类型检查通过、server/worker 冒烟启动正常。

这个项目为什么存在、边界在哪里，见 [docs/vision.md](docs/vision.md)（愿景与缘起）；架构设计见 [docs/architecture.md](docs/architecture.md)。

路线图：

- [ ] Phase 1「带 AI 的若依」：RBAC + 组织 + 审计 + 模型配置 + 内置对话 Agent
- [ ] Phase 2「Agent 资源化」：声明式 Agent 定义 + MCP 工具注册 + 版本发布 + HITL 审批
- [ ] Phase 3「企业深化」：成本分摊 + 评测 + 知识库插件 + OIDC

## License

规划：核心 Apache-2.0，部分企业模块商业授权（open-core）。
