# Bio Agent

微信小程序形态的对话式 Agent 产品。后端使用 TypeScript、NestJS、Fastify 和 Pi Coding Agent SDK，模型接入 DeepSeek。

## 目录

```text
apps/
  api/          API、Pi 会话、工具和运行记录
  debug-console/ React + Vite 调试台
  miniprogram/  原生 TypeScript 微信小程序
packages/
  contracts/    前后端消息、面板与事件协议
infra/          本地 PostgreSQL、Redis 配置
```

## 本地启动

要求 **Node.js 22.19+（推荐 24 LTS）**、pnpm 11.19。Pi SDK 固定为 `@earendil-works/pi-coding-agent@0.84.4`。Node 22.14 不满足该 SDK 的要求。

```bash
cp .env.example .env
pnpm install
# 在 .env 中填写 DEEPSEEK_API_KEY
pnpm dev:api
```

另开终端启动调试台：

```bash
pnpm dev:web
```

访问 `http://127.0.0.1:5173`，可编辑 System Prompt、连续对话、查看回复、Markdown 面板原文、用量、估算费用和服务端 Trace。清空 Conversation ID 可开始新会话。相同 ID 会恢复历史；并发提交同一会话返回 409。

例如输入：`请用面板展示一份三点写作提纲，然后简短告诉我。`

API 默认监听 `http://127.0.0.1:3000`。目前供本地开发使用，尚未实现登录、用户归属校验和数据库持久化；会话与 Trace 接口按单用户、单进程设计。

将 `apps/miniprogram` 导入微信开发者工具即可运行小程序。默认首页是全屏狐狸动画场景：首次进入会挥手问候一次，随后保持伏案静止，并以较长随机间隔偶发眨眼。业务代码可通过动画控制器触发一次性动作。对话调试页沿用兼容接口，暂未消费面板和语音事件。开发阶段需要关闭域名校验；发布前配置合法 HTTPS 域名。

## 接口

- `GET /api/v1/health`：健康检查。
- `POST /api/v1/chat/completions`：等待 Pi 完成后返回兼容的完整响应。
- `POST /api/v1/agent/runs/stream`：相同请求体，以 NDJSON 连续返回产品事件和最终结果。
- `GET /api/v1/agent/runs/:runId/trace`：读取本次运行的本地 Trace。

请求示例（`conversationId` 可省略；填写时必须是 UUID v4）：

```json
{
  "message": "帮我整理写作提纲",
  "systemPrompt": "你是一个表达简洁的写作助手。"
}
```

响应保留 `conversationId`、`message`、`finishReason`、`model`、`usage` 和 `estimatedCost`，增加 `runId` 与 `events`。再次请求时带上返回的 `conversationId`。省略 `systemPrompt` 时沿用已保存设定；提供非空设定时更新。

流式调用：

```bash
curl -N http://127.0.0.1:3000/api/v1/agent/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"请用面板展示一份写作提纲"}'
```

每行是独立 JSON：`{"kind":"event","event":...}`、`{"kind":"result","result":...}` 或 `{"kind":"error","message":...}`。流开始后错误在流内返回，客户端需检查 `kind`。断开请求会取消执行；默认运行超时为 120 秒。

## 验证

```bash
pnpm typecheck
pnpm build
pnpm test
```

API 集成测试使用真实 Pi SDK 和本地模拟 OpenAI 兼容服务，不需要 API Key，不访问付费模型。覆盖会话恢复与隔离、工具循环、事件流、取消、并发保护、压缩恢复和错误处理。

## 架构与范围

参见 [Agent 架构说明](docs/agent-architecture.md)。已实现 Pi 会话历史、自动压缩、Markdown 展示工具、产品事件与本地运行记录。长期 Memory、文章版本存储、ASR/TTS、人物事件联动、数据库和分布式任务执行留待后续接入。

基础设施仍面向 PostgreSQL、Redis、OSS 和 SLS；本次骨架无需启动 Docker。
