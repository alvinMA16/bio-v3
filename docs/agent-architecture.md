# Agent SDK 骨架

## 分层

```text
小程序 / 调试台
  → ChatController（兼容 JSON）或 AgentController（NDJSON）
  → AgentService（运行 ID、并发保护、取消、超时、事件与用量）
  → PiSessionFactory（模型、人物设定、会话恢复、压缩、工具白名单）
  → Pi Coding Agent SDK（模型调用和工具循环）
  → 产品工具（当前为 show_panel）
```

前端依赖 `@bio/contracts`，不依赖 Pi 事件类型。API 使用 ESM / NodeNext，与 Pi 的 ESM 发布包兼容。

## 会话与存储

`AGENT_DATA_DIR` 在启动工作目录下解析。标准 `pnpm dev:api` 从 `apps/api` 启动，示例值 `../../.bio-agent` 指向仓库根目录：

```text
.bio-agent/
  conversations/<conversationId>/
    persona.json       用户选择的人物设定
    session.jsonl      Pi 历史、工具结果和压缩记录
  traces/<runId>.jsonl  输入、Pi 事件和产品事件
```

每次请求打开对应 Pi 会话，结束后释放实例，下一次重新从文件恢复。当前的并发锁在单个 API 进程内生效，不可让多个 API 实例共同写这一目录。客户端提供的 ID 必须是 UUID v4，不能成为任意文件路径。

SDK 的资源发现已关闭：不会自动加载宿主用户的扩展、Skills、AGENTS.md、提示词模板或模型配置。仅开放产品工具。模型凭证从服务配置传入 Pi 的内存凭证层。

## 上下文

Pi 自动压缩已启用：为输出预留 16,384 tokens，保留近期约 20,000 tokens。当前适配为文本工具交互，保守配置 131,072 tokens 的上下文预算、8,192 tokens 的单次输出上限，thinking 关闭。模型上下文预算不是 DeepSeek 最大窗口的声明。

人物设定独立保存，恢复会话时重新加载。长期 Memory 尚未实现；以后可从用户资料库读取偏好，再通过资源加载或上下文扩展注入。文章内容和版本应由业务存储管理，不以会话摘要作为文章原文。

## 产品事件与工具

普通助手文本生成 `speech.delta` 和 `speech.completed`，表示可供字幕/播报使用的文本；不表示音频已经合成或播放。每次助手消息都有独立 `messageId`，重试和后续回复不会被拼成一条消息。

`show_panel` 接收 `panelId`、`title` 和 Markdown `content`，校验参数后生成 `panel.updated`。相同 ID 表示更新同一面板。它不保存文章，也不确认客户端已经完成渲染。调试台在运行结束后展示 Markdown 原文；小程序和实时面板消费仍需接入。

其他事件包括工具开始/完成、上下文压缩开始/完成，以及运行开始、完成、失败和取消。每个产品事件都有 `runId`、`conversationId`、时间和序号。序号与服务端 Trace 共用，前端看到的序号允许有间隔。

添加业务工具时，在独立文件中定义参数和执行逻辑，通过 `PiSessionFactory` 注册并加入白名单。需要改变产品展示时，发出共享协议中定义的事件。工具只有在业务写入成功后才能报告保存或修改成功。

## Trace 和计费

记录运行输入、Pi 生命周期/工具/压缩/重试事件，以及产品事件。流式更新只保存增量，不重复写入每次累积的完整消息；终态消息保存完整内容。当前同步追加 JSONL，保证单进程内的顺序并及时发现磁盘错误，适用于开发骨架；生产应迁移到有持久化保障的日志或数据库写入通道。

这些记录不包含提供商原始 HTTP 请求/响应，也不包含尚未接入的语音和客户端播放事件。因此它不是完整音视频端到端 Trace。历史 Trace 含用户内容，后续接入登录时必须增加用户归属检查。

返回的用量汇总本次运行各次模型回复和 SDK 提供的压缩用量。人民币费用沿用项目现有 DeepSeek 估算价格；未知模型目前沿用旧行为返回零估算，不能理解为免费。Pi 未提供独立推理 token 细分时，兼容字段 `reasoningTokens` 为 0。账单以提供商为准。

## 后续接入口

- 用户身份：将认证用户与 conversation / run 关联，替换当前单用户访问方式。
- 持久化：对接 PostgreSQL，保留 Pi 会话恢复所需的数据，并明确多实例的会话写入所有权。
- Memory：存储、修改和检索用户偏好，与运行日志和文章数据分别管理。
- 文章：增加读取和带版本检查的修改工具，展示内容引用或修改对比。
- 语音：输入接 ASR；字幕文本接 TTS；人物动画跟随实际播放状态。

## 上游依据

固定依赖版本的安装包类型声明与源码是接入依据。在线 main 分支的 API 可能继续变化。

- [Pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
- [上下文压缩](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)
- [会话格式](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)
