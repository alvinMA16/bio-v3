# 通话记忆 v1

## 结构与读取

PostgreSQL 保存概要、详细记忆、来源、版本、通话原文和后台任务。未设置 `MEMORY_DATABASE_URL` 时不启用，保留原本本地调试行为，不把文件记忆冒充为数据库记忆。

- Overview：`preferences` 是用户偏好与交流约定的主要保存位置；`entries` 是人物、故事、互动与近况的简短摘要与内部 ID。没有独立 profile 分类。偏好最多 24 项、入口最多 30 项，文本合计最多 2400 字符；这不是精确 Token 计数。
- person：人物、称谓、关系与有依据的背景。
- story：人生经历、事件经过、明确表达的感受与不确定点。
- interaction：最近聊了什么、做了什么、这些互动形成的当前状态。不是单纯的待办清单。实时屏幕与选区继续使用现有动态上下文。

每通电话创建新 conversationId，固定一份当时已提交的 Overview，作为系统上下文中的 `bio_memory_overview`，同一调用不重复追加。每轮仍保留常驻记忆规则、SDK 历史与压缩摘要、实时展示状态。偏好无需工具读取。当前用户的纠正优先于历史信息。

只给通话 Agent 三个只读工具：

| 工具 | 输入 | 输出 |
|---|---|---|
| search_memory | query，可选 type、offset | 最多 8 条标题、摘要、版本、ID；nextOffset 翻页 |
| read_memory | memoryId，可选 offset | 正文片段、当前版本、来源；nextOffset 继续 |
| read_source | sourceRef，或 callId + after | 原始消息及角色、来源、时间；按通话读取时 nextAfter 翻页 |

搜索是参数化的大小写不敏感子串匹配，支持中文，空白分隔的关键词按 OR 匹配；转义 `%`、`_`，不声称具备语义检索。正文每页 6000 字符；通话原文每页最多 8 条、每条最多 4000 字符；单条较长时用 sourceRef/textOffset 继续读，后台检查每条消息的完整覆盖。摘要、检索结果、工具参数与来源不会自动成为字幕或音频。模型通过常驻规则区分内部引用与自然表达；规则不是绝对泄露保证，仍需真实模型回归。

来源保留在独立关联表；读取时作为 source_ref 返回。当前来源支持文字输入、ASR 最终转写、助手回复和工具执行元数据。事实与偏好必须引用用户消息；interaction 可引用工具执行记录。助手扩写不作为事实依据。资料文件页码/段落级来源尚未接入本版，附件原件仍使用现有资料模块。

## 挂断后写入

1. 通话中的用户原文、完整助手回复和工具状态立即入库；不调用记忆写入模型。
2. 客户端发送独立 `hangup`，服务端关闭语音并等待 Agent 取消及原文写入结束。
3. `calls` 结束与 `jobs` 创建在一条原子 SQL 中完成；callId 是任务唯一键。
4. 后台 worker 用数据库 advisory lock 保证同一用户的任务串行。进程退出释放锁，其他 worker 可恢复 running 任务。
5. 整理器使用真实 Pi SDK 的独立内存 Session。只开放记忆读取工具与 `propose_memory_batch`，不提供 shell、文件浏览或作品修改工具。
6. 必须通过出处工具读完本通电话所有消息；程序检查消息 ID 覆盖情况，未读完不能提交候选。旧记忆按需检索。长通话由分页工具配合 SDK 压缩处理。
7. 候选包含详细记忆变更和完整新 Overview。服务端校验用户归属、来源、版本、概要引用和长度，再一次事务提交详细记忆、版本、来源、概要与任务完成状态。
8. 没有新信息时允许 noChange，只标记任务完成。

明确纠正更新当前有效记忆，旧版和原始依据保留；不明确的矛盾由整理器标记不确定。局部要求不升级为永久偏好。挂断前不声称本轮信息已经长期保存。

整理任务使用服务端默认模型，记录 SDK 返回的用量，不混入通话返回费用。上限为 180 秒、100 次工具调用；失败自动重试最多 3 次，30 秒间隔。failed 任务阻止同用户后续任务越序覆盖，可通过重试接口恢复。错误记录不保存模型原文或凭证。语义是否忠实仍需要真实模型评测；SQL 校验只能验证结构与来源存在，不能证明每句话确实由该出处支持。

## 生命周期与恢复

Web 和小程序每个语音客户端生成 callId；同一连接的所有 turn 共用它。新电话创建新的 SDK 会话；客户端传入的旧 conversationId 不覆盖服务器分配。

主动关闭发送 hangup。断网、错误、页面隐藏不发送 hangup：服务端给予默认 60 秒重连宽限；协议允许用原 callId 在宽限期重新连接，继续原 conversationId。当前 UI 仍以关闭并释放麦克风为主，未实现自动重连按钮/流程。超过宽限后后台结束通话；进程崩溃后，超过 3 分钟没有心跳的通话也会被回收。旧连接不能关闭已被新连接恢复的通话。

上一通整理尚未完成时，新电话使用已提交概要，并获得最多两通 pendingCalls 的原文入口；不阻塞新通话。纯文字入口能读记忆并存原文，本版只有电话结束触发整理。

## 数据与身份

建表定义在 `apps/api/src/memory/schema.ts`，启动时在事务与迁移锁下执行幂等 DDL。表名前缀 `bio_memory_`，不修改现有其他表。

生产身份由 `MEMORY_AUTH_TOKENS` 的服务端令牌映射解析；客户端只能提交令牌，不能指定 userId。HTTP 使用 Bearer。浏览器 WebSocket 使用 `bio-voice` 和 `bio-auth.<token>` 子协议，小程序使用 Authorization 请求头。令牌使用随机 ASCII 字符，浏览器子协议需符合 token 字符规则。该机制是试用接入边界，不是完整的账号注册/微信登录系统。

所有记忆读取和来源查询限制用户。概览版本与条目更新一起提交。SDK 同一 conversation 的运行使用数据库 advisory lock，用户隔离的本地目录只是适配缓存；session.jsonl、panel.json、persona.json 在运行结束时写回数据库，下次可在不同目录恢复。进程中途崩溃时可恢复上次已提交的 SDK 快照，消息原文独立保存，不保证恢复尚未提交的工具修改。

当前资料原件和 Trace 仍是本地存储；Trace 增加运行归属校验。资料模块原有单用户边界、作品的跨会话打开/编辑、对象存储、真实账号体系仍需后续接入，不能据此宣称整个应用已支持多用户公网部署。新记忆会话不会自动导入旧无主本地会话。

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
```

数据库集成测试使用真实 PostgreSQL、真实 Pi SDK 与本地模拟模型，验证原文与记忆分离、来源与用户隔离、事务回滚、纠正版本、SDK 跨目录恢复和整理器工具循环。没有调用付费模型或使用真实用户数据。
