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

## 连续阅读与客户端反馈

Web 与小程序展示连续全文，无页码、翻页按钮、选段或“改这段”入口。用户直接口述修改目标；指代不明确时 Agent 用口头问题澄清。

客户端滚动停止 180ms 后上报 documentView.visibleRanges（blockId + UTF-16 start/end）和 following。正文用最多 80 个 Unicode 字符的行内片段测量与视口的交集，边缘可能包含少量屏外文字；不是逐字可见性或眼动追踪。客户端开口检测时刷新位置；Web 在获取下一轮请求时也同步刷新，小程序文字发送前等待测量。位置同步复用 document.view，不发起模型调用，不打断当前语音。

服务端校验文稿归属、版本、段落及偏移，只从已保存正文提取 screen.visibleContent；拒绝旧版本和无效范围。空数组表示正文不在可视区域，null 表示尚无有效报告。新通话可用有效视口打开已有文稿；通话中的迟到报告不能切换文稿。滚动报告不写入 panel.json，也不改变朗读游标。模型每次调用前读取最新视口。

## 精确定位回执

Web 对 `show_document` 的 blockId / highlights 定位独立于朗读跟随：先等布局，再滚动，下一帧确认目标文字进入阅读区。目标暂未出现或滚动未生效时最多尝试 6 次，整个请求限时 1.2 秒；用户滚轮、触摸滑动、指针操作或翻页按键立即终止定位，新请求和组件卸载取消旧请求。确认之前不将请求标为完成。

客户端在 `document.view.navigation` 回传同一 requestId 的 received（WebSocket 收到指令，含加载的脚本文件名）、rendering（阅读器开始处理）、visible/failed（最终结果）。记录尝试次数、滚动前后位置、目标与视口纵向坐标、前端耗时，并独立报告目标高亮 visible/not_visible/missing/not_requested。可见性取阅读区与浏览器视口的交集，缺少滚动容器明确返回 scroller_missing。

语音服务等待最多 2 秒；中间阶段不结束等待，最终回执立即结束等待，超时保留最后收到的阶段。核对轮次、文稿、版本及请求 ID，内容工具还校验可见范围包含目标起点。show_document 返回 visible / failed / unconfirmed 和 rendered；请求高亮时还要求 highlightRendered=true 才算整体成功。失败/未确认通过结构化错误传递，保证 Pi 的 tool_execution_end / tool.completed.isError=true，而不只是正常工具结果正文写“失败”。这不撤销文稿展示指令，也不回滚正文。没有回执的旧客户端和文字请求同样不能声称精确定位成功；普通打开文稿和朗读推进不等待精确定位回执。

运行 Trace 的 input/document.view 记录收到的反馈及轮次是否接受，不含正文。工具结果保留最终回执或超时阶段，可区分 no_matching_receipt、reader_not_started、reader_not_completed、invalid_viewport 和 highlight_not_confirmed。没有回执仍不能单凭服务端区分未刷新旧页面、未送达或已断开的客户端；不要从超时推断滚动算法是根因。

## 分段朗读与自动跟随

内部保留每段最多 600 字的 documentPages、page/navigation、screen.readingPage 和 totalPages，作为朗读分段与旧客户端兼容协议，不向用户展示“页”。全文朗读从 show_document(page=1, follow=true) 开始，逐段输出并用 navigation=next 推进。当前可见内容朗读依据 visibleContent；不能将内部朗读分段等同于当前屏幕。

VoiceSession 的 beforeShow 等待此前 TTS 队列及客户端播放回执完成后再推进。等待保留 45 秒无进展超时；用户开口打断、断线或播放失败会取消。普通滚动不打断声音，只停止客户端自动跟随；正常推进不能强制恢复跟随。用户明确要求重新从头读或恢复跟随时才传 follow=true。新打开文稿默认跟随。正文版本更新后重新测量，手动浏览位置尽量由浏览器滚动锚定保留。

边界：自动跟随按朗读分段推进，未做逐字音频时间对齐。模型逐字复述仍可能漏字或改词。语音预算与播放回执机制保持原有约束。

## 验证

- documents.test.mjs：读取/展示/修改分离、版本恢复、Unicode 分页、旧稿迁移、账号隔离、跨会话并发冲突、PostgreSQL 事务。
- document-playback.test.mjs：未播放完不翻页、无效/旧回执无效、打断后不翻页。
- agent.test.mjs / Gemini / bench：真实 Pi 工具循环、动态上下文、新工具白名单与会话恢复。
- pnpm typecheck、pnpm test、Web 构建；数据库集成测试需要 MEMORY_TEST_DATABASE_URL 指向独立测试库。

Web 三种通话模式共用紧凑底栏。每次新呼叫在麦克风授权、音频初始化、角色素材、玻璃渲染模块和首屏附件准备期间显示拨号页面，书桌页提前加载并复用场景素材，预热玻璃图形资源。拨号开始便连接 Agent，麦克风授权、录音模块与界面准备并行；麦克风就绪前不播放开场或开放录音。拨号先响三声轻柔回铃（共约 3 秒），未接通时按原节奏继续回铃；界面与麦克风准备完成后，在完整尾音结束或声间空隙释放暂存的开场事件和语音，避免无声等待或截断提示音。每声采用圆滑起音与延长衰减，取消或失败时也短暂淡出。资源准备失败或超过 25 秒显示可重拨的错误。准备完成后，首次收到 listening 状态或开场白音频才接通并开始计时，后续轮次不重置时长。只有普通对话显示回复正文；三种模式均复用玻璃状态，显示“我在听 / 令狸在思考 / 令狸正在说”。拨号期间不显示通话底栏；失败后提供重拨和返回。

Web 普通对话使用深色背景，上方拱形视频窗展示毛毡书房和令狸，下方显示回复文字，不重复角色标题。拨号同样使用深色背景，只显示稳定的“正在呼叫”、独立生成的生活头像随回铃轻轻缩放，柔和鼠尾草绿光晕与三层更清晰的扩散波纹共用音频时钟（减少动态效果时静止）；本地轻柔回铃音在接通、取消或失败时停止。三种模式的彩色玻璃状态条独立于底栏，横向铺满屏幕；底栏左侧仅显示令狸与通话时长，右侧是 112px 宽的短滑轨，实际滑动距离 60px。底栏去掉外层胶囊、阴影和嵌套背景，采用两列布局，最窄 220px 手机预览也为名字和时间保留独立空间。仅从圆钮拖至轨道末端并松开才结束，短拖、点击轨道、取消拖动或明显拖离轨道均不触发；键盘需移动至末端后按回车确认。滑轨内部完整显示“滑动退出”，没有箭头或轨道外标题；深色界面使用低对比度轨道和鲜红圆钮，左右内容垂直居中对齐。

## 阅读字号

字号五档为“小号、较小、标准、较大、大号”，默认标准。通话正文默认从 16px 降为 15px；其余阅读标题、文稿集预览和普通对话文字按相同比例缩放，按钮、状态栏、图片及 PDF 原件保持原样。用户可以要求“调小一点”“调大一点”、指定名称或恢复默认；相对调整只移动一档，边界保持当前档位。

Agent 使用 `set_reading_font_size`，不编辑文稿正文。设置在 Agent 持久化目录的 reading-preferences 中按账号哈希隔离、原子写入，跨会话、刷新和服务重启保留；匿名开发预览单独保存。GET `/api/v1/agent/reading-preferences` 复用现有账号身份解析。Web 本地缓存也按账号隔离，用于初次显示，服务端为准；较早的读取响应不能覆盖已收到的最新调整事件。

调整通过 reading.preference.updated 实时下发，正文在 220ms 内平滑改变，底部短暂显示“字号已从标准调为较小”等命名提示，3 秒自动消失，连续操作替换提示。恢复已有设置不弹提示。减少动态效果模式取消动画、保留文字反馈。新客户端声明 readingFontControl 能力，旧页面调用时返回刷新提示，不保存或虚报调整成功。
