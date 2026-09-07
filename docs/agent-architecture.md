# Agent SDK 骨架

## 分层

```text
小程序 / 调试台
  → ChatController（兼容 JSON）或 AgentController（NDJSON）
  → AgentService（运行 ID、并发保护、取消、超时、事件与用量）
  → PiSessionFactory（模型、人物设定、会话恢复、压缩、工具白名单）
  → Pi Coding Agent SDK（模型调用和工具循环）
  → 产品工具（set_panel_mode / update_panel_content / get_panel_state）
```

前端依赖 `@bio/contracts`，不依赖 Pi 事件类型。API 使用 ESM / NodeNext，与 Pi 的 ESM 发布包兼容。

## 会话与存储

`AGENT_DATA_DIR` 在启动工作目录下解析。标准 `pnpm dev:api` 从 `apps/api` 启动，示例值 `../../.bio-agent` 指向仓库根目录：

```text
.bio-agent/
  conversations/<conversationId>/
    persona.json       用户选择的人物设定
    session.jsonl      Pi 历史、工具结果和压缩记录
    panel.json        当前面板、已登记附件与本地草稿
  traces/<runId>.jsonl  输入、Pi 事件和产品事件
```

每次请求打开对应 Pi 会话，结束后释放实例，下一次重新从文件恢复。当前的并发锁在单个 API 进程内生效，不可让多个 API 实例共同写这一目录。客户端提供的 ID 必须是 UUID v4，不能成为任意文件路径。

SDK 的资源发现已关闭：不会自动加载宿主用户的扩展、Skills、AGENTS.md、提示词模板或模型配置。仅开放产品工具。模型凭证从服务配置传入 Pi 的内存凭证层。

## 上下文

Pi 自动压缩已启用：为输出预留 16,384 tokens，保留近期约 20,000 tokens。当前适配为文本工具交互，保守配置 131,072 tokens 的上下文预算、8,192 tokens 的单次输出上限，thinking 关闭。模型上下文预算不是 DeepSeek 最大窗口的声明。

### 模块与插入顺序

`apps/api/src/agent/agent-context.ts` 统一组装三段常驻规则：核心身份与边界、语言表达规则、能力与操作约定。已有 `systemPrompt` 参数只覆盖人物设定，仍保留公共规则；名称固定为令狸，旧人物设定中的名称不再生效。所有普通输出（包括工具前后说明）直接用于播报，不应出现 Markdown 或排版符号；结构化内容写入面板。

每轮请求的逻辑顺序：

```text
常驻 system prompt
Pi 历史（含已有压缩摘要、近期原文与完整工具调用/结果）
本轮动态上下文：场景 + 服务端场景指引 + 服务端 panel 状态 + 客户端选区快照
本轮用户消息
本轮随后产生的助手工具调用 / 工具结果
```

使用应用内置的 Pi `context` 扩展，在每次模型调用前插入一个临时 custom message。Pi 0.84.4 将其转换为独立 user-role 消息；它不是高优先级 system 指令，也不是用户新发言。常驻规则说明其用途、数据边界和用户明确任务优先的约定。`display: false`，不产生产品字幕事件。

插入只作用于发送给模型的消息副本，不写进 `session.jsonl`，不进入历史压缩源。每轮只保留一份提交时快照，工具循环中位置不变，不拆开工具调用与结果。工具执行后的新状态应由工具结果表达。请求 Trace 仍保留输入快照，便于追溯。

两个入口（JSON 与 NDJSON）均接受可选字段：

```json
{
  "message": "把这段改得口语一些",
  "context": {
    "scene": "revision",
    "workspace": {
      "documentId": "article-1",
      "version": 12,
      "selectedBlockId": "paragraph-2",
      "excerpt": "用户选中或与任务有关的正文"
    }
  }
}
```

场景为 `conversation`（默认）、`interview`、`revision`。详细指引在服务端维护，客户端不能提交任意指引。客户端选区快照的文档 ID 和非负整数版本必填，标题、选区 ID 可选，正文上限 12,000 字符；这是字符上限，不是 Token 计量。长文应由调用方选择相关片段，不自动截断选区。

每次提交完整当前选区快照；省略 workspace 表示本轮没有客户端选区，不恢复历史选区。panel 则从本地会话存储恢复，包含当前模式和可用对象；正文提供最多 6000 字符的预览，标明截断，可通过读取工具补足。workspace 只是参考，不能覆盖 panel 的正文或版本。工具更新草稿时检查本地存储版本。

调试台提供场景、文章 ID、版本、选区和正文输入；Inspector 中可查看本轮请求。此次没有增加额外模型分类调用、技能读取或第二套历史摘要机制。

人物设定独立保存，恢复会话时重新加载。长期 Memory 尚未实现；以后可从用户资料库读取偏好，再通过资源加载或上下文扩展注入。文章内容和版本应由业务存储管理，不以会话摘要作为文章原文。

## 产品事件与工具

普通助手文本生成 `speech.delta` 和 `speech.completed`，表示可供字幕/播报使用的文本；不表示音频已经合成或播放。每次助手消息都有独立 `messageId`，重试和后续回复不会被拼成一条消息。

面板有三个独立于对话场景的模式：`conversation`（不打开正文或附件）、`attachment`（查看原件）、`editor`（共同编辑草稿）。切回纯对话保留已有附件和草稿。

- `set_panel_mode(mode, targetId?)`：切换模式并打开已登记对象；禁止编造附件 ID。
- `update_panel_content(documentId, expectedVersion, title?, operations)`：创建草稿或按段落插入、替换、删除，成功后自动进入 editor。新建版本为 0，保存后递增。操作批次在副本上校验后原子替换本地文件，版本冲突或任一操作失败均不部分保存。
- `get_panel_state(documentId?, blockId?, attachmentId?)`：默认获取有界状态；按 ID 读取完整草稿、单段或附件文本。不能把附件和草稿选择器混用。

草稿使用带稳定 ID 的结构化块：paragraph、heading、list（每行一项）、quote、code。前端按块类型渲染，不执行正文 HTML。工具结果只返回模式、版本、对象 ID 等简短确认；完整 UI 数据通过 `panel.state.updated` 事件发送。初始恢复也发送一次状态事件，错误或取消前已经保存的更新不会回滚。客户端是否完成渲染尚无确认协议，不能把更新事件当作渲染确认。

附件通过请求的 `context.attachments` 登记，例如：

```json
{"id":"photo1","kind":"image","title":"童年照片","url":"https://example.com/photo.png"}
```

图片需提供 HTTPS 地址；文档提供文本或 HTTPS 地址。同一 ID 的原件内容不可改变，要修改则创建独立草稿。此入口用于本地调试；生产接入应改为引用归属已校验的上传资源。当前无上传、PDF 解析或视觉模型能力，照片地址只让客户端展示，模型不能据此声称理解图片细节。

调试台消费 NDJSON，实时显示按 messageId 分开的普通回复和面板变化，并展示工具执行、模式切换、文档版本的到达时间线。桌面配置区和结果区独立滚动，运行时定位结果区；取消或断流保留已收到的文字、面板及变化记录。客户端收到事件的耗时不代表实际语音播放耗时。草稿显示本次修改前后差异，可点选段落作为下一轮选区。小程序聊天页在整轮 JSON 返回后显示最新面板并支持选段，尚未接入实时面板流。历史 `panel.updated` 类型保留用于旧调试记录显示；新运行不再注册 `show_panel`。

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
- 文章：将本地草稿迁入业务文档库，补充权限、多端并发、发布与撤销；保持版本校验和附件原件隔离。
- 语音：输入接 ASR；字幕文本接 TTS；人物动画跟随实际播放状态。

## 上游依据

固定依赖版本的安装包类型声明与源码是接入依据。在线 main 分支的 API 可能继续变化。

- [Pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
- [上下文压缩](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)
- [会话格式](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)
