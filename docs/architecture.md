# AgentMix 架构设计（v0 草案）

> 状态：设计阶段（2026-08），随讨论持续演进。修改本文档需记录变更理由。

## 定位与差异化

**Agent 时代的若依 / Ant Design Pro**：一个开源的企业级后台框架，其中 AI Agent 与用户、角色、菜单一样，是被统一管理的资源。

| 类别 | 代表 | AgentMix 的差异 |
|---|---|---|
| Agent 框架 | LangGraph、CrewAI、AutoGen、Mastra | 它们是代码库不是平台：无 UI、无管理后台、无 RBAC |
| LLMOps 平台 | Dify、FastGPT | App 中心而非组织中心，RBAC/组织架构/审计很弱 |
| 观测/网关 | LangFuse、Helicone | 只管 trace 和成本，不管人和权限 |
| 传统 Admin 脚手架 | 若依、Ant Design Pro、Soybean | 无任何 Agent 概念 |
| 商用一体化 | 腾讯 ADP Agent Portal、RestCloud | 闭源/商用，开源侧无对应物 |

目标用户：需要给几十至几千名员工下发 AI 能力的企业内部团队；用 AgentMix 起一个内部系统，既有完整的账号/权限/审计骨架，又能开箱管理 Agent、模型、工具与成本。

## 五个核心支柱

1. **Agent 一等公民资源模型**（最关键差异化）
   RBAC 的 subject 除 user/role 外增加 `agent` 类：谁能创建、谁能发布、哪个部门可见、能用哪个模型。Agent 同样持有权限去调用内部 API（替员工干活），人与 Agent 在同一套权限模型内。

2. **控制面 / 执行面分离**
   Admin（控制面）管 CRUD、配置、权限、审计；Agent Runtime（执行面）是无状态 worker。两平面通过队列（Redis/BullMQ）+ 事件连接。执行面可水平扩展，未来可加 Python worker（跑 LangGraph）而不动架构。

3. **模型网关 + 成本中心**
   统一多模型接入（OpenAI 兼容协议为底）、密钥保险箱、按部门/按 Agent 的配额与账单分摊。

4. **Human-in-the-loop 框架级审批**
   敏感工具调用（发邮件、改数据、花钱）自动挂起进入 Admin 审批中心，通过后继续执行。传统 Admin 的审批流成为 Agent 治理手段。

5. **核心小、插件化、MCP-first**
   不自研编排引擎；执行层适配 Vercel AI SDK（预留 LangGraph）；工具系统直接押注 MCP；知识库、评测、通知等做成可选模块。

## Monorepo 结构（规划）

```
pnpm workspace + Turborepo
├── apps/
│   ├── admin/        # Next.js + antd（管理面）/ Tailwind（工作台工具类）：Admin 控制台 + Agent 工作台
│   ├── server/       # NestJS：认证/RBAC/组织/模型网关/审计（tRPC 或 REST）
│   └── agent-worker/ # Agent 执行面：BullMQ 消费、OTel 埋点
├── packages/
│   ├── core/         # Agent Spec（Zod schema，声明式 Agent 定义）
│   ├── sdk/          # 代码态编写 Agent 的 SDK
│   └── ui/           # antd 之上的业务组件层（AgentCard、PermissionTree 等领域封装）
```

数据层：Postgres（Drizzle）+ Redis。部署目标：`docker compose up` 一条命令跑通。

## MVP 路径

- **Phase 1「带 AI 的若依」**：登录/RBAC/组织/审计 + 模型配置 + 内置对话 Agent + 会话审计。可直接拿去给企业做 POC。
- **Phase 2「Agent 资源化」**：声明式 Agent 定义（YAML/TS）+ MCP 工具注册表 + 版本化发布/回滚 + 权限绑定 + HITL 审批流。
- **Phase 3「企业深化」**：成本分摊、评测、知识库（RAG）插件、OIDC 登录；SSO(SAML)/多租户留给 Enterprise 版。

## 开源策略

- License：核心 Apache-2.0；SSO(SAML)、多租户 SaaS 模式等做 Enterprise 付费模块（Cal.com / GitLab 的 open-core 模式）。RBAC 与审计必须开源。
- 双社区：中英双语文档，GitHub + 国内渠道并行运营。
- 叙事：「不是又一个 Dify，而是给企业内部系统装 Agent 的底座框架」。

## 命名备注

2026-08-19 定名 **AgentMix Admin**（仓库 `agent-mix-admin`，npm scope `@agentmix`，标识符 `agentmix`）。此前工作名 `agentmuster` 因拼写生僻难记弃用。命名查重结论：`agent-mix-admin` 与 `agentmix` 均无开源占用（最接近的是不同拼写的 AgentMesh 等项目）。历史排查记录：`agentdock`（[已有同名知名框架](https://github.com/AgentDock/AgentDock)）、`agentfort`（[同名商业产品](https://agentfort.net/)）、`agentyard`（[agentyard.dev 已有生态](https://github.com/gregm711/agentyard.dev)）、`agentbureau`（[同名 org](https://github.com/agentbureau)）、`agentkeep`（多个同名小项目）均因冲突排除。
