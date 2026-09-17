# 通话记忆 v1

## 结构与读取

PostgreSQL 保存概要、详细记忆、来源、版本、通话原文和后台任务。未设置 `MEMORY_DATABASE_URL` 时不启用，保留原本本地调试行为，不把文件记忆冒充为数据库记忆。

- Overview：`preferences` 是用户偏好与交流约定的主要保存位置；`entries` 是人物、故事、互动与近况的简短摘要与内部 ID。没有独立 profile 分类。偏好最多 24 项、入口最多 30 项，文本合计最多 2400 字符；这不是精确 Token 计数。
- person：人物、称谓、关系与有依据的背景。
- story：人生经历、事件经过、明确表达的感受与不确定点。
- interaction：用户与令狸之间持续的互动及当前进展，可跨通话更新，不是按次聊天流水或单纯的待办清单。实时屏幕与选区继续使用现有动态上下文。
- call_history：每通电话的简短摘要、可选后续关注点和已有原文入口。复用 `bio_memory_calls`，通过服务端分配的 `callId` 关联 `bio_memory_messages`，不复制原文，也不改变三类详细记忆。overview 不重复维护按次摘要目录。

每通电话创建新 conversationId，不自动携带上一通 SDK 历史。在电话开始事务中固定一份 `initial_context`，包含当时已提交的 Overview、本次开始时间、最近已完成的通话摘要及最多两通待整理原文入口；作为系统上下文中的 `bio_memory_overview`。后续轮次与重连复用同一快照，后台整理完成不替换当前前缀。迁移前已开始的电话在首次读取时固定一次。每轮仍保留本通 SDK 历史与压缩摘要、实时展示状态。偏好无需工具读取，当前用户的纠正优先于历史信息。

`MEMORY_RECENT_CALL_COUNT` 默认 3，允许 0–20；非法值回退为 3。按实际通话开始时间选取最近已完成摘要，从旧到新注入；空通话不占名额。时间由服务端记录并格式化为北京时间（+08:00），不另存渠道和时区字段。开始时间不是持续刷新的时钟。后续关注只是可选线索，优先回应用户本次意图，较新的结果/取消/纠正优先于旧计划；不把结束语当作下次交谈的意愿。

一条模型可见的通话历史示例：

```json
{
  "callId": "call-example-0917",
  "started_at": "2026-09-17T21:00:00.000+08:00",
  "ended_at": "2026-09-17T21:20:00.000+08:00",
  "summary": "用户临时加班没能回老家。姐姐已陪母亲就医，用户还不知道检查结果。",
  "follow_ups": [{ "topic": "母亲的检查结果", "not_before": null, "context": "已就医，结果尚未知。" }]
}
```

整理器只生成 `summary` 与 `follow_ups`，不生成 ID 或时间。摘要最多 250 个 Unicode 字符，短通话无需凑字；后续关注最多两项，可为空。`not_before` 是北京时间下最早适合问起的日期（YYYY-MM-DD）或 null，不是自动提醒。原文发言时间用于解析“两天后”等表达，无法确定时不猜。服务端校验结构、长度和日期，但不能证明语义忠实；真实模型表现需要额外评测。

只给通话 Agent 四个记忆只读工具：

| 工具 | 输入 | 输出 |
|---|---|---|
| search_call_history | 可选 query、date、offset | 当前用户已结束的通话时间、摘要、callId；每页 8 条，nextOffset 翻页。date 按北京时间的开始日期匹配。摘要未完成或旧电话未生成时为 null，仍可读取原文 |
| search_memory | query，可选 type、offset | 最多 8 条标题、摘要、版本、ID；nextOffset 翻页 |
| read_memory | memoryId，可选 offset | 正文片段、当前版本、来源；nextOffset 继续 |
| read_source | sourceRef，或 callId + after | 原始消息及角色、来源、时间；按通话读取时 nextAfter 翻页 |

搜索是参数化的大小写不敏感子串匹配，支持中文，空白分隔的关键词按 OR 匹配；转义 `%`、`_`，不声称具备语义检索。正文每页 6000 字符；通话原文每页最多 8 条、每条最多 4000 字符；单条较长时用 sourceRef/textOffset 继续读，后台检查每条消息的完整覆盖。摘要、检索结果、工具参数与来源不会自动成为字幕或音频。模型通过常驻规则区分内部引用与自然表达；规则不是绝对泄露保证，仍需真实模型回归。

历史关键词搜索匹配摘要和用户原文，日期与关键词可组合；`callId` 由初始背景或搜索结果提供，然后调用 `read_source({callId, after: 0})`，严格使用返回的 nextAfter 继续读取。服务端绑定用户权限，工具不接受 userId；内部 callId 不在普通回复或语音中展示。

来源保留在独立关联表；读取时作为 source_ref 返回。当前来源支持文字输入、ASR 最终转写、助手回复和工具执行元数据。事实与偏好必须引用用户消息；interaction 可引用工具执行记录。助手扩写不作为事实依据。资料文件页码/段落级来源尚未接入本版，附件原件仍使用现有资料模块。

## 挂断后写入

1. 通话中的用户原文、完整助手回复和工具状态立即入库；不调用记忆写入模型。
2. 客户端发送独立 `hangup`，服务端关闭语音并等待 Agent 取消及原文写入结束。
3. `calls` 结束与 `jobs` 创建在一条原子 SQL 中完成；callId 是任务唯一键。
4. 后台 worker 用数据库 advisory lock 保证同一用户的任务串行。进程退出释放锁，其他 worker 可恢复 running 任务。
5. 整理器使用真实 Pi SDK 的独立内存 Session。只开放记忆读取工具与 `propose_memory_batch`，不提供 shell、文件浏览或作品修改工具。
6. 必须通过出处工具读完本通电话所有消息；程序检查消息 ID 覆盖情况，未读完不能提交候选。旧记忆按需检索。长通话由分页工具配合 SDK 压缩处理。
7. 候选同时包含本通 `callSummary`、详细记忆变更和完整新 Overview。服务端校验用户归属、来源、版本、概要引用和长度，再一次事务提交通话摘要、详细记忆、版本、来源、概要与任务完成状态。
8. 没有长期新信息时允许 noChange，但有实际用户发言仍必须保存通话摘要；完全空通话跳过模型并标记完成。失败回滚摘要及长期记忆，重试写入同一 callId，不生成重复历史。

明确纠正更新当前有效记忆，旧版和原始依据保留；不明确的矛盾由整理器标记不确定。首次讲述的具体经历不应只留在通话摘要里；明确的称呼和交流偏好进入概要。只有核对后没有长期新增或纠正时才使用 noChange；服务端拒绝 noChange=true 却同时携带 batch 的矛盾候选，避免默默丢弃变更。局部要求不升级为永久偏好。挂断前不声称本轮信息已经长期保存。

整理任务使用服务端默认模型，记录 SDK 返回的用量，不混入通话返回费用。上限为 180 秒、100 次工具调用；失败自动重试最多 3 次，30 秒间隔。failed 任务阻止同用户后续任务越序覆盖，可通过重试接口恢复。错误记录不保存模型原文或凭证。语义是否忠实仍需要真实模型评测；SQL 校验只能验证结构与来源存在，不能证明每句话确实由该出处支持。

## 生命周期与恢复

Web 和小程序每个语音客户端生成 callId；同一连接的所有 turn 共用它。新电话创建新的 SDK 会话；客户端传入的旧 conversationId 不覆盖服务器分配。

主动关闭发送 hangup。断网、错误、页面隐藏不发送 hangup：服务端给予默认 60 秒重连宽限。Web 和小程序在意外断线后有限重连，优先用原 callId 恢复原 conversationId；页面隐藏不自动重新开麦。超过宽限后后台结束通话；进程崩溃后，超过 3 分钟没有心跳的通话也会被回收。旧连接不能关闭已被新连接恢复的通话。详见[语音恢复协议](realtime-voice.md)。

上一通整理尚未完成时，新电话使用已提交概要，并获得最多两通 pendingCalls 的原文入口，包括已断开但仍在宽限期的电话；不纳入其他正在活动的通话。每轮额外加载 bio_voice_recovery，补充最近通话和播放进度，不改写固定的 initial_context。bio_voice_playback 按用户、通话和轮次保存生成/发送/播放状态，只接受当前连接的更新；记忆整理参考该状态，不把完整生成等同于用户听完或同意。纯文字入口能读记忆并存原文，本版只有电话结束触发整理。

历史已完成任务不会自动重新运行模型补摘要；旧电话仍能按日期或用户原文关键词查找并读取。新增 nullable 字段以幂等迁移方式添加，不改写已有原文。

## 数据与身份

建表定义在 `apps/api/src/memory/schema.ts`，启动时在事务与迁移锁下执行幂等 DDL。表名前缀 `bio_memory_`，不修改现有其他表。

生产已接入[手机号账号体系](accounts.md)：`AUTH_ENABLED=true` 时，HTTP Bearer 和 WebSocket 登录会话通过 AuthService 解析为用户身份，客户端不能指定 userId。浏览器 WebSocket 使用 `bio-voice` 和 `bio-auth.<token>` 子协议，小程序使用 Authorization 请求头。仅在未启用账号体系的私有预览模式下，才使用 `MEMORY_AUTH_TOKENS` 的服务端令牌映射。

所有记忆读取和来源查询限制用户。概览版本与条目更新一起提交。SDK 同一 conversation 的运行使用数据库 advisory lock，用户隔离的本地目录只是适配缓存；session.jsonl、panel.json、persona.json 在运行结束时写回数据库，下次可在不同目录恢复。进程中途崩溃时可恢复上次已提交的 SDK 快照，消息原文独立保存，不保证恢复尚未提交的工具修改。

每个 API 进程的记忆连接池上限为 12，同时最多接纳 8 个持锁的 SDK 运行（文字与语音合计，包含正在初始化的运行）。后台整理串行占用至多 1 个连接，为原文归档、检索和通话心跳等短查询保留 3 个连接的容量。超额请求立即返回 503「服务繁忙，请稍后重试」；NDJSON 已开始响应时通过流内 error 返回。拒绝的运行不调用模型、不归档用户消息。名额在快照保存与数据库连接释放后归还，失败和取消也走相同清理路径；不能单独提高运行上限而不重新核算连接预算。此限制按进程生效，多实例仍须核算 PostgreSQL 总连接容量。

资料原件和 Trace 仍是本地存储，已接入用户归属校验；账号、资料、文稿和界面缓存隔离见账号说明。对象存储和作品的跨会话语音续改不属于记忆模块。新记忆会话不会自动导入旧无主本地会话；已有 owner 数据绑定手机号时保留原身份及全部来源关联。

## 本地启用

```sh
docker compose -f infra/docker-compose.yml up -d postgres
```

在被忽略的 `.env` 中配置：

```dotenv
MEMORY_DATABASE_URL=postgresql://bio:bio@localhost:5432/bio
MEMORY_DEV_USER_ID=local-user
```

重启 API。仅非 production 环境接受开发用户。多用户试用时移除开发用户，设置令牌映射；调试台“长期记忆”面板输入令牌，小程序开发者工具可设置 `wx.setStorageSync('bio-auth-token', token)`。令牌不会写入聊天请求体或 Trace。

调试台可查看 Overview 与任务状态：

- `GET /api/v1/memory/overview`
- `GET /api/v1/memory/jobs`
- `POST /api/v1/memory/jobs/:callId/retry`：只重试归属当前用户的 failed 任务。

## 验证

```sh
pnpm typecheck
pnpm build
pnpm test
# 使用独立测试库，测试以随机用户隔离并清理自己的记录：
MEMORY_TEST_DATABASE_URL=postgresql://... node --test apps/api/test/memory.test.mjs
# 容量回归：包括真实连接池满载、超额拒绝和失败/取消后的名额恢复
MEMORY_TEST_DATABASE_URL=postgresql://... node --test apps/api/test/memory-capacity.test.mjs
```

数据库集成测试使用真实 PostgreSQL、真实 Pi SDK 与本地模拟模型，验证原文与记忆分离、来源与用户隔离、事务回滚、纠正版本、SDK 跨目录恢复和整理器工具循环。没有调用付费模型或使用真实用户数据。

### 真实模型验收

`apps/api/test/memory-live.mjs` 是显式开启的付费模型验收，不随普通测试运行。使用独立测试数据库和合成身份，验证首次整理、全新会话召回、纠正后再次召回、原文保留及用户隔离。模型配置从 `.env` 读取，测试库必须显式提供；完成或异常时清理本次合成身份的数据与临时文件。

```sh
pnpm --filter @bio/api build
MEMORY_LIVE_EVAL=true MEMORY_TEST_DATABASE_URL=postgresql://... \
  node --env-file=.env apps/api/test/memory-live.mjs
```

这组固定样例通过只能证明相应链路与样例行为，不代表长期、多主题通话的语义准确率。通话任务成功也不等于全部信息都应成为长期记忆；空通话不会生成摘要，纯文字入口目前不触发后台整理。
