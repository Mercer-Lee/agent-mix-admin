# AGENTS.md — AgentMix 工作区指令

AgentMix Admin（仓库 `agent-mix-admin`，npm scope `@agentmix`）—— 面向企业的 Admin + Agent 一体化后台框架。
一句话定位：**不是又一个 Dify，而是给企业内部系统装 Agent 的底座框架**——把 Agent 当成被 RBAC 管理的一等企业资源。

当前状态：🚧 骨架已落地。pnpm workspace + Turborepo monorepo 已初始化并全部可构建，尚无数据库接入与业务功能（下一步：Phase 1 —— Drizzle schema + 认证/RBAC）。

## 常用命令

- `pnpm build` / `pnpm typecheck` / `pnpm test` —— turbo 全仓任务
- `pnpm dev` —— 并行启动 admin(:3100) / server(:3101) / agent-worker
- `docker compose up -d` —— 本地 Postgres + Redis
- 构建产物在各自包的 `dist/`（admin 为 `.next/`），均被 gitignore
- 本仓库钉住 TypeScript 6.x：TS 7.0 缺编译器 API，Nest CLI 与 tsup dts 均不兼容，待 7.1 发布后评估升级

## 工作约束（重要）

- 架构上严格控制面（Admin）与执行面（Agent Runtime）分离，二者只通过队列/事件通信，不允许执行面以直接写库之外的方式耦合进 Admin。
- Agent 是一等公民资源：权限模型中 subject 除 user/role 外必须包含 agent。不要把 Agent 做成"配置项"，它是被管理、被授权、被审计的资源。
- 工具系统 MCP-first：不造私有工具协议，优先复用 MCP 生态。
- 明确不做：低代码可视化编排画布（Dify 的主场，红海）、自研 LLM 编排引擎（执行层走适配器：Vercel AI SDK 优先，预留 LangGraph 适配）。
- 企业能力分级：RBAC、审计、成本核算属于开源核心；SSO（SAML）、多租户 SaaS 模式属于未来的 Enterprise 版，不要提前实现进核心。
- 修改架构决策（`docs/architecture.md` 中的内容）前先与维护者确认，并在文档中记录变更理由。
- 任何随 git 共享的文件（含 `.zcode/config.json`、`docker-compose.yml`、示例代码）中禁止出现明文密钥；密钥一律走环境变量（见 `.env.example`）。
- 涉及安全面（密钥保险箱、权限模型、审批流）的代码改动，必须附带测试。

## 技术栈约定

- Runtime：Node.js 24（见 `.node-version`），包管理 pnpm 10（workspace）。
- 语言：TypeScript，strict 模式，ESM 优先。
- UI 分工：管理面（表格/表单/布局）用 antd v6；Agent 工作台与页面细节用 Tailwind v4 工具类。admin 的 Tailwind preflight 已关闭以兼容 antd（见 `apps/admin/app/globals.css` 注释），勿重新开启。
- 规划中的 monorepo 结构见 `docs/architecture.md`：`apps/admin`（Next.js）、`apps/server`（NestJS）、`apps/agent-worker`（BullMQ）、`packages/*`。
- 代码标识符与 commit message 用英文；面向用户的文档以中文为主、英文为辅（双社区策略）。
