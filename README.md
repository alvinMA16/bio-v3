# Bio Agent

微信小程序形态的对话式 Agent 产品。主后端使用 TypeScript、NestJS 和 Fastify，模型默认接入 DeepSeek；生产基础设施面向阿里云 RDS、Redis、OSS 和 SLS。

## 目录

```text
apps/
  api/          NestJS + Fastify API 与 Agent runtime
  debug-console/ React + Vite Agent 调试台
  miniprogram/  原生 TypeScript 微信小程序
packages/
  contracts/    前后端对话与领域协议
infra/          本地 PostgreSQL、Redis 配置
```

## 本地启动

要求 Node.js 22+、pnpm 11+，以及可选的 Docker。

```bash
cp .env.example .env
pnpm install
docker compose -f infra/docker-compose.yml up -d
pnpm dev:api
```

另开一个终端启动 Web 调试台：

```bash
pnpm dev:web
```

访问 `http://127.0.0.1:5173`，可以编辑 System Prompt、发起运行、查看模型、Token 用量、人民币预估费用、耗时、原始请求/响应和本地运行历史。人民币费用按 `USD_TO_CNY_RATE` 配置的汇率从 DeepSeek 美元挂牌价换算。

API 默认监听 `http://127.0.0.1:3000`：

- `GET /api/v1/health`：健康检查
- `POST /api/v1/chat/completions`：等待模型完成后返回完整回复

将 `apps/miniprogram` 导入微信开发者工具即可运行小程序。开发阶段需要在开发者工具中关闭域名校验；发布前把 `app.ts` 的地址替换为已备案 HTTPS 域名并加入小程序 request 合法域名。

## 对话接口

请求：

```json
{"message":"你好","conversationId":"可选"}
```

后端等待 DeepSeek 完成后返回一个 JSON 响应，小程序再一次性渲染助手消息：

```json
{
  "conversationId": "...",
  "message": {
    "id": "...",
    "role": "assistant",
    "content": "完整回复",
    "createdAt": "2026-08-26T00:00:00.000Z"
  },
  "finishReason": "stop"
}
```

## 架构边界

- `ModelProvider` 隔离 DeepSeek，后续可加入其他 OpenAI 兼容模型。
- PostgreSQL 将保存用户、会话、消息、Agent 运行轨迹和文件元数据。
- Redis/BullMQ 将承担长任务、重试、限流和异步工具调用。
- OSS 只保存对象，数据库保存对象 key、归属与访问策略；客户端不持有永久 AccessKey。
- 生产环境通过服务端签发短期上传凭证或预签名 URL。

目前是可运行骨架，尚未加入微信登录、持久化、OSS SDK、任务队列和计费。
