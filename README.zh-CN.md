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
cp .env.example .env             # 设置 PostgreSQL 变量与 DATABASE_URL、
                                  # 管理员密码和模型相关变量
pnpm db:migrate && pnpm db:seed   # 初始化表结构与管理员
pnpm dev                          # admin :3100 · server :3101 · agent-worker
```

本地开发优先复用本机已安装的 PostgreSQL 和 Redis，并在 `.env` 中配置对应的 `DATABASE_URL` 和 `REDIS_URL`。使用 Compose 时，需要填写 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`，并让 `DATABASE_URL` 使用同一组值。如果本机没有这两项服务，可使用仓库提供的 Compose 配置启动：

```bash
docker compose up -d              # 启动容器化的 Postgres + Redis
```

Docker Desktop 已内置 `docker compose` 子命令，无需另行安装旧版 `docker-compose`。环境变量模板见 [.env.example](.env.example)。控制面 API 健康检查：`curl localhost:3101/api/health`。`pnpm dev` 启动时，admin 会先等待控制面（`:3101`）就绪再拉起，因此启动完成后立即可安全访问控制台。

## 状态

✅ Phase 1 已完成：

- [x] **Phase 1A — 控制面基础：** Drizzle/PostgreSQL 数据模型、数据库 Session、user/role/agent 统一 RBAC、审计事件、受保护的 Admin 登录闭环和隔离数据库集成测试。
- [x] **Phase 1B — 受治理的 Agent 资源：** Capability Registry 与统一执行器、`users.search` 纵向样板、Agent CRUD 与状态管理、角色/直接权限分配、实时 Capability 发现和 Admin Agent 管理界面。
- [x] **Phase 1C — 受治理 Runtime 闭环：** 环境托管模型配置、user/role/department 显式调用授权、受保护的系统 Agent、事务 outbox、BullMQ 流式 Runtime、可续传 SSE 对话、停止生成、受双重授权的 `users.search` 桥、用量、模型检查和正文分权会话审计。

Phase 1 之后的控制台打磨：Admin 控制台已具备可折叠侧边栏布局（图标栏 + 悬停浮层，移动端抽屉）与中英双语（基于 next-intl，语言记忆在 Cookie，顶栏与登录页均可切换）。

Worker 不读 PostgreSQL、不调用 Server HTTP，Server 不直接调用模型；凭证只存在于 Worker 环境。通用 MCP 传输、审批流和 Agent 版本发布仍属于 Phase 2。

这个项目为什么存在、边界在哪里，见 [docs/vision.md](docs/vision.md)（愿景与缘起）；架构设计见 [docs/architecture.md](docs/architecture.md)。

路线图：

- [x] Phase 1「带 AI 的若依」：模型 → Agent → Runtime → 工具 → 审计纵向闭环
- [ ] Phase 2「Agent 资源化」：声明式 Agent 定义 + MCP 工具注册 + 版本发布 + HITL 审批
- [ ] Phase 3「企业深化」：成本分摊 + 评测 + 知识库插件 + OIDC

## License

规划：核心 Apache-2.0，部分企业模块商业授权（open-core）。

## 验证

`pnpm test:integration` 会启动隔离的 PostgreSQL 17 与 Redis 7 Testcontainers，并使用本地假 OpenAI-compatible SSE 服务。需要复用本地仓库或缓存镜像时，可设置 `TEST_POSTGRES_IMAGE` 与 `TEST_REDIS_IMAGE`。
