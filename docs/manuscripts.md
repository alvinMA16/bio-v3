# 文稿、展示位置与 Agent 工具

## 原稿与持久化

原稿为 schemaVersion=1 的 JSON：id、title、version、blocks。每个块有稳定 id、kind、纯文本 text；当前支持 paragraph、heading、quote、list、code。列表按换行分项，正文不执行 HTML。标题、段落结构和原文是内容；阅读分页、字号、PDF 纸张和公众号样式属于展示/导出，不写入原稿。

生产沿用 MEMORY_DATABASE_URL 对应的 PostgreSQL：

- bio_documents：按 (user_id,id) 隔离的当前正文 JSONB、版本、来源会话、创建及更新时间。
- bio_document_revisions：每次 edit_document 或 restore_document 成功后的完整快照、版本、来源会话、修改说明、时间。一次工具提交是一版。
- 正文和历史在同一事务提交；按用户与文稿加事务锁，检查 expectedVersion，跨会话的旧版本写入失败。恢复旧版生成新版本，不覆盖或删除历史。
- panel.json 只保留会话展示状态和正文缓存；恢复会话时从文稿库刷新，不能用旧快照覆盖新正文。
- 未配置数据库时，单进程开发适配器在 AGENT_DATA_DIR/documents/<owner-hash>/documents.json 原子保存正文和历史；不适合多实例部署。

数据库建表是 MemoryService 初始化时的增量幂等迁移。旧会话中的无 schemaVersion 文稿在访问文稿库/启动 Agent 时导入；旧 ID 与来源会话组合哈希为独立 ID，避免不同会话都叫 draft 时碰撞。导入只写不存在的记录，重复导入不会覆盖修改。旧稿只导入现存快照，没有凭空补造更早版本。旧 manuscripts/:conversationId/:documentId 链接保留兼容。

附件原件继续走原有资料服务和私有 OSS。文稿正文不放 OSS。以后增加文稿插图应保存 assetId，再经归属校验解析资源；导出的 PDF、Word 或排版 HTML 应作为绑定 documentId/version 的派生文件放 OSS 的 bio-v3/ 下。本次没有新增 PDF/Word/公众号导出器、发布接口或 OSS 写入。

## 工具契约

| 工具 | 行为 | 展示与正文 |
| --- | --- | --- |
| read_document | 无 ID 列目录；有 ID 读全文，可指定 blockId 或 page；includeHistory 返回版本摘要 | 不翻页、不写入 |
| edit_document | 新建或按块 insert/replace/delete；expectedVersion 必填；summary 可选 | 保存正文与历史；仅刷新已经显示的同一文稿，不打开新稿 |
| show_document | documentId 打开；page 指定页，navigation=next/previous 翻页，blockId 定位 | 进入 revision、更新展示位置；不增加文稿版本 |
| restore_document | documentId、expectedVersion、sourceVersion | 将旧正文恢复为新版本；用户明确要求时使用 |
| read_attachment | attachmentId 读取原件的可用文字或地址 | 不修改原件、不切换展示 |
| switch_mode | conversation、attachment_conversation 或空白 revision | 切换场景；已有文稿通过 show_document 打开 |

新稿推荐省略 documentId，由服务端生成 UUID，工具返回 ID 后再展示或追加。显式指定 ID 时 expectedVersion=0 只允许创建尚不存在的文稿。创建不再要求先进入 revision。

例：edit_document(expectedVersion=0,title,operations) → show_document(documentId,page=1)。改一段：read_document(documentId,blockId) → edit_document(documentId,expectedVersion,operations)。工具层与只读 HTTP 文稿 API 共用存储；没有用户直接写正文的 API。

## 阅读页与客户端反馈

packages/contracts/src/documents.ts 提供共享分页：尽量保留完整段落，每页最多 600 个 Unicode 码点，超长段落分片并携带 blockId/start/end（UTF-16 偏移）。空文档也有一页。小屏可在一页内滚动，阅读页不是“屏幕恰好一屏”或 PDF 页。

PanelState.documentView 保存 documentId/version/page；展示事件包含完整文稿与派生 readingPages，方便微信端无运行时包依赖地渲染。Web 使用同一个分页函数。改稿后按原页首段落及位置定位；若删除则夹取有效页码。

客户端在渲染后和手动翻页时提交 context.documentView；语音中通过 document.view 消息更新。服务端验证文稿属于当前用户、版本与页码有效后才接纳，不接受客户端上传正文覆盖原稿。模型每次调用前更新上下文，screen.readingPage 包含当前页精确片段，totalPages 给出总页数。renderAcknowledged 只表示收到匹配的客户端显示报告，不代表用户看过或理解。

文稿集可打开文稿并选择“和令狸一起看这篇”，新通话可以继续处理已有文稿。手动翻页时若正在回复，客户端打断旧轮，防止旧朗读随后自动把用户翻回去。

Web 文稿通话页以正文铺满背景，标题独占整行，重复的首段标题只展示一次（不改正文存储），令狸缩到通话栏，正文独立滚动；底部保留状态、时长、挂断和最多两行字幕，不另设专注模式或麦克风、扬声器开关。点击段落后才展示“和令狸改这段”；确认后将原文、blockId 和版本交给 Agent。语音中选择段落会打断当前轮，并在新一轮监听开始前同步选区上下文。用户仍通过 Agent 改稿，前端不直接编辑正文。

## 逐页朗读

保留普通 Agent 文本 → TTS，不新增朗读工具，不让播放器自行决定文稿内容。指引要求模型根据当前页逐字输出原文；全文朗读用 show_document(page=1) → 输出当前页 → show_document(next) → 输出下一页。

VoiceSession 给 Agent 工具提供运行时 beforeShow 回调。show_document、edit_document、restore_document 在变更展示/正在阅读的正文前，等待此前回复的 TTS 队列完成，并等待客户端累计播放样本回执覆盖已发送音频。翻页工具随后返回，模型继续下一页；不需要伪造用户消息或另建朗读模型。

等待播放期间暂停 Agent 的执行超时，播放自身保留 45 秒无进展超时。用户打断、断线、播放器失败会取消等待，不翻下一页。没有播放回执的旧客户端在存在未播音频时拒绝自动翻页。Agent 完成与播放器播放完仍是不同事件。

边界：模型逐字复述可能出现漏字/改词。普通通话的每轮语音预算仍为 20,000 字符；打开文稿后为 50,000 字符，覆盖当前最大 40,000 字符原稿及简短说明。本次没有做逐字时间对齐、无限长度续轮、自动人声抢话或暂停后自动恢复整篇朗读。真实模型和设备需要体验验证；自动化使用确定性的模型/ASR/TTS 替身验证时序与持久化。

## 验证

- documents.test.mjs：读取/展示/修改分离、版本恢复、Unicode 分页、旧稿迁移、账号隔离、跨会话并发冲突、PostgreSQL 事务。
- document-playback.test.mjs：未播放完不翻页、无效/旧回执无效、打断后不翻页。
- agent.test.mjs / Gemini / bench：真实 Pi 工具循环、动态上下文、新工具白名单与会话恢复。
- pnpm typecheck、pnpm test、Web 构建；数据库集成测试需要 MEMORY_TEST_DATABASE_URL 指向独立测试库。

Web 三种通话模式共用紧凑底栏。首次呼叫在麦克风授权、音频初始化和服务端语音识别准备期间显示拨号页面；首次收到 listening 状态才开始计时，后续轮次不重置时长。等待期间可取消，失败后可重拨。
